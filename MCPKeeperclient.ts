/**
 * MCP-based KeeperHub client.
 *
 * Connects to the KeeperHub MCP server over HTTP (StreamableHTTP transport)
 * and exposes the three keeper tools as typed async methods:
 *   registerTask()   → KeeperTaskRegistration
 *   getTaskStatus()  → KeeperTaskStatusResult
 *   cancelTask()     → KeeperCancelResult
 *
 * x402 payment
 * ────────────
 * KeeperHub requires a USDC micro-payment (via EIP-3009 transferWithAuthorization)
 * for each `register_keeper_task` call.  The X402Handler handles the
 * challenge-response cycle transparently before the MCP tool call proceeds.
 */
import { Client }                         from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport }  from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ethers }                         from 'ethers';
import { X402Handler, X402Error }         from './x402';
import type { HexString }                 from './types';
import type {
  KeeperCancelResult,
  KeeperTaskParams,
  KeeperTaskRegistration,
  KeeperTaskStatusResult,
  X402Challenge,
} from './KeeperTypes';

// ─── Errors ───────────────────────────────────────────────────────────────────

export class MCPConnectionError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'MCPConnectionError';
  }
}

export class MCPToolError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`MCP tool "${toolName}" failed: ${message}`);
    this.name = 'MCPToolError';
  }
}

export class MCPResponseParseError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
  ) {
    super(`Failed to parse response from MCP tool "${toolName}": ${message}`);
    this.name = 'MCPResponseParseError';
  }
}

// ─── MCPKeeperClient ──────────────────────────────────────────────────────────

/**
 * Lifecycle: construct → connect() → use → close()
 *
 * The client is NOT thread-safe; create one instance per agent invocation or
 * use a connection pool for concurrent workloads.
 */
export class MCPKeeperClient {
  private client: Client | null = null;
  private readonly x402: X402Handler;
  private readonly mcpEndpoint: string;

  constructor(
    mcpEndpoint: string,
    signer: ethers.Wallet,
    paymentChainId: number,
    usdcAddress: HexString,
  ) {
    if (!mcpEndpoint) throw new Error('MCPKeeperClient: mcpEndpoint is required');
    this.mcpEndpoint = mcpEndpoint;
    this.x402 = new X402Handler(signer, paymentChainId, usdcAddress);
  }

  // ─── Connection lifecycle ─────────────────────────────────────────────────────

  /**
   * Establishes the MCP connection.
   * Performs a pre-auth probe so x402 credentials are ready before the
   * first tool call, reducing per-call latency.
   * Must be called before any tool method.
   */
  async connect(): Promise<void> {
    if (this.client !== null) return; // already connected

    let transport: StreamableHTTPClientTransport;
    try {
      // Pre-fetch to get x402 challenge and compute payment header once.
      // KeeperHub may issue a session-scoped token or accept per-request auth.
      const authHeader = await this.preAuth();

      transport = new StreamableHTTPClientTransport(
        new URL(this.mcpEndpoint),
        {
          requestInit: {
            headers: authHeader ? { 'X-PAYMENT': authHeader } : {},
          },
        },
      );
    } catch (err) {
      throw new MCPConnectionError(
        `Failed to initialise MCP transport to ${this.mcpEndpoint}: ${String(err)}`,
        err,
      );
    }

    this.client = new Client(
      { name: 'surveychain-keeper-agent', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    try {
      await this.client.connect(transport);
    } catch (err) {
      this.client = null;
      throw new MCPConnectionError(
        `MCP handshake failed with ${this.mcpEndpoint}: ${String(err)}`,
        err,
      );
    }
  }

  /** Closes the MCP connection and releases resources. */
  async close(): Promise<void> {
    if (this.client === null) return;
    try {
      await this.client.close();
    } finally {
      this.client = null;
    }
  }

  // ─── Tool: register_keeper_task ───────────────────────────────────────────────

  /**
   * Registers a keeper task with KeeperHub.
   *
   * KeeperHub will call `distributeRewards(ensNode)` on the target contract
   * at `params.triggerTimestamp`, using private routing and dynamic gas.
   * Retries up to `params.retries` times on transient failures.
   */
  async registerTask(params: KeeperTaskParams): Promise<KeeperTaskRegistration> {
    const raw = await this.callTool('register_keeper_task', {
      ensNode:         params.ensNode,
      contractAddress: params.contractAddress,
      calldata:        params.calldata,
      triggerTimestamp: params.triggerTimestamp,
      chainId:         params.chainId,
      retries:         params.retries,
      gasStrategy:     params.gasStrategy,
      routing:         params.routing,
      paymentMethod:   params.paymentMethod,
    });

    return this.parseTaskRegistration(raw);
  }

  // ─── Tool: get_task_status ────────────────────────────────────────────────────

  async getTaskStatus(taskId: string): Promise<KeeperTaskStatusResult> {
    if (!taskId || taskId.trim() === '') {
      throw new Error('getTaskStatus: taskId must not be empty');
    }
    const raw = await this.callTool('get_task_status', { taskId });
    return this.parseTaskStatus(raw);
  }

  // ─── Tool: cancel_task ────────────────────────────────────────────────────────

  async cancelTask(taskId: string): Promise<KeeperCancelResult> {
    if (!taskId || taskId.trim() === '') {
      throw new Error('cancelTask: taskId must not be empty');
    }
    const raw = await this.callTool('cancel_task', { taskId });
    return this.parseCancelResult(raw);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private assertConnected(): Client {
    if (this.client === null) {
      throw new MCPConnectionError(
        'MCPKeeperClient is not connected. Call connect() before using tool methods.',
      );
    }
    return this.client;
  }

  private async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const client = this.assertConnected();

    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await client.callTool({ name: toolName, arguments: args });
    } catch (err) {
      throw new MCPToolError(toolName, String(err), err);
    }

    if (result.isError) {
      const errText = Array.isArray(result.content)
        ? result.content.map((c) => ('text' in c ? c.text : '')).join(' ')
        : String(result.content);
      throw new MCPToolError(toolName, errText);
    }

    // Extract text content and parse as JSON
    if (!Array.isArray(result.content) || result.content.length === 0) {
      throw new MCPResponseParseError(toolName, 'Empty content array in MCP response');
    }

    const firstContent = result.content[0];
    if (!firstContent || !('text' in firstContent) || typeof firstContent.text !== 'string') {
      throw new MCPResponseParseError(
        toolName,
        `Expected text content, got: ${JSON.stringify(firstContent)}`,
      );
    }

    try {
      return JSON.parse(firstContent.text) as unknown;
    } catch (err) {
      throw new MCPResponseParseError(
        toolName,
        `Response is not valid JSON: ${firstContent.text.slice(0, 200)}`,
      );
    }
  }

  /**
   * Sends a probe request to obtain the x402 challenge and computes a
   * payment header valid for this session.
   * Returns an empty string if KeeperHub does not require payment (dev mode).
   */
  private async preAuth(): Promise<string> {
    let probeResponse: Response;
    try {
      probeResponse = await fetch(this.mcpEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 0, params: {} }),
      });
    } catch (err) {
      throw new MCPConnectionError(
        `Network error reaching KeeperHub at ${this.mcpEndpoint}: ${String(err)}`,
        err,
      );
    }

    if (probeResponse.status !== 402) {
      // No payment required (dev/free tier) — proceed without auth header
      return '';
    }

    let challenge: X402Challenge;
    try {
      challenge = await this.x402.parseChallenge(probeResponse);
    } catch (err) {
      if (err instanceof X402Error) throw err;
      throw new MCPConnectionError(
        `Failed to parse x402 payment challenge: ${String(err)}`,
        err,
      );
    }

    try {
      return await this.x402.buildPaymentHeader(challenge);
    } catch (err) {
      throw new MCPConnectionError(
        `Failed to build x402 payment header: ${String(err)}`,
        err,
      );
    }
  }

  // ─── Response parsers ─────────────────────────────────────────────────────────

  private parseTaskRegistration(raw: unknown): KeeperTaskRegistration {
    if (typeof raw !== 'object' || raw === null) {
      throw new MCPResponseParseError(
        'register_keeper_task',
        `Expected object, got ${typeof raw}`,
      );
    }
    const obj = raw as Record<string, unknown>;
    this.requireString(obj, 'taskId', 'register_keeper_task');
    this.requireNumber(obj, 'scheduledFor', 'register_keeper_task');
    this.requireNumber(obj, 'confirmedAt', 'register_keeper_task');

    return {
      taskId:              obj['taskId'] as string,
      scheduledFor:        obj['scheduledFor'] as number,
      confirmedAt:         obj['confirmedAt'] as number,
      estimatedGasLimit:   typeof obj['estimatedGasLimit'] === 'number'
        ? obj['estimatedGasLimit']
        : 600_000,
    };
  }

  private parseTaskStatus(raw: unknown): KeeperTaskStatusResult {
    if (typeof raw !== 'object' || raw === null) {
      throw new MCPResponseParseError('get_task_status', `Expected object, got ${typeof raw}`);
    }
    const obj = raw as Record<string, unknown>;
    this.requireString(obj, 'taskId', 'get_task_status');
    this.requireString(obj, 'status', 'get_task_status');
    this.requireNumber(obj, 'scheduledFor', 'get_task_status');

    const validStatuses = [
      'pending', 'scheduled', 'executing', 'completed', 'failed', 'cancelled',
    ];
    if (!validStatuses.includes(obj['status'] as string)) {
      throw new MCPResponseParseError(
        'get_task_status',
        `Unknown status "${String(obj['status'])}"`,
      );
    }

    return {
      taskId:           obj['taskId'] as string,
      status:           obj['status'] as KeeperTaskStatusResult['status'],
      scheduledFor:     obj['scheduledFor'] as number,
      lastAttemptAt:    typeof obj['lastAttemptAt'] === 'number' ? obj['lastAttemptAt'] : null,
      executionTxHash:  typeof obj['executionTxHash'] === 'string'
        ? obj['executionTxHash'] as HexString
        : null,
      retryCount:       typeof obj['retryCount'] === 'number' ? obj['retryCount'] : 0,
      lastError:        typeof obj['lastError'] === 'string' ? obj['lastError'] : null,
    };
  }

  private parseCancelResult(raw: unknown): KeeperCancelResult {
    if (typeof raw !== 'object' || raw === null) {
      throw new MCPResponseParseError('cancel_task', `Expected object, got ${typeof raw}`);
    }
    const obj = raw as Record<string, unknown>;
    this.requireString(obj, 'taskId', 'cancel_task');

    return {
      taskId:      obj['taskId'] as string,
      success:     typeof obj['success'] === 'boolean' ? obj['success'] : true,
      cancelledAt: typeof obj['cancelledAt'] === 'number' ? obj['cancelledAt'] : Date.now() / 1000,
    };
  }

  private requireString(
    obj: Record<string, unknown>,
    key: string,
    tool: string,
  ): void {
    if (typeof obj[key] !== 'string' || (obj[key] as string).trim() === '') {
      throw new MCPResponseParseError(tool, `Field "${key}" must be a non-empty string`);
    }
  }

  private requireNumber(
    obj: Record<string, unknown>,
    key: string,
    tool: string,
  ): void {
    if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key] as number)) {
      throw new MCPResponseParseError(tool, `Field "${key}" must be a finite number`);
    }
  }
}
