/**
 * Tests for MCPKeeperClient.
 *
 * The MCP SDK Client and StreamableHTTPClientTransport are mocked.
 * global.fetch is mocked so preAuth() does not hit the network.
 * The X402Handler is mocked to avoid ethers signing calls.
 */

const mockCallTool   = jest.fn();
const mockClientConnect = jest.fn().mockResolvedValue(undefined);
const mockClientClose   = jest.fn().mockResolvedValue(undefined);

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect:  mockClientConnect,
    callTool: mockCallTool,
    close:    mockClientClose,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));

jest.mock('../agent/x402', () => ({
  X402Handler: jest.fn().mockImplementation(() => ({
    parseChallenge:    jest.fn().mockResolvedValue({ version: 1, accepts: [] }),
    buildPaymentHeader: jest.fn().mockResolvedValue('mock-payment-header'),
  })),
  X402Error: class X402Error extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'X402Error';
    }
  },
}));

import {
  MCPKeeperClient,
  MCPConnectionError,
  MCPToolError,
  MCPResponseParseError,
} from '../agent/MCPKeeperclient';
import type { KeeperTaskParams } from '../agent/KeeperTypes';
import type { HexString } from '../agent/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_SIGNER = {
  getAddress:    jest.fn().mockResolvedValue('0x' + 'ab'.repeat(20)),
  signTypedData: jest.fn().mockResolvedValue('0x' + 'cd'.repeat(65)),
} as unknown as import('ethers').Wallet;

const VALID_TASK_PARAMS: KeeperTaskParams = {
  ensNode:          ('0x' + 'aa'.repeat(32)) as HexString,
  contractAddress:  ('0x' + 'bb'.repeat(20)) as HexString,
  calldata:         '0xdeadbeef' as HexString,
  triggerTimestamp: Math.floor(Date.now() / 1000) + 3570,
  chainId:          11155111,
  retries:          10,
  gasStrategy:      'dynamic',
  routing:          'private',
  paymentMethod:    'x402',
};

function makeClient(endpoint = 'https://keeperhub.example.com/mcp') {
  return new MCPKeeperClient(
    endpoint,
    MOCK_SIGNER,
    1,
    ('0x' + 'cc'.repeat(20)) as HexString,
  );
}

function makeToolResult(data: unknown) {
  return {
    isError: false,
    content: [{ text: JSON.stringify(data) }],
  };
}

// ─── Constructor validation ───────────────────────────────────────────────────

describe('MCPKeeperClient — constructor', () => {
  it('constructs with valid arguments', () => {
    expect(() => makeClient()).not.toThrow();
  });

  it('throws when mcpEndpoint is empty', () => {
    expect(() => makeClient('')).toThrow('mcpEndpoint is required');
  });
});

// ─── connect / close lifecycle ────────────────────────────────────────────────

describe('MCPKeeperClient — connect / close', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    (global as unknown as Record<string, unknown>).fetch = mockFetch;
    mockClientConnect.mockResolvedValue(undefined);
    mockClientClose.mockResolvedValue(undefined);
  });

  it('connects without throwing when MCP handshake succeeds', async () => {
    const client = makeClient();
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('is idempotent — second connect() is a no-op', async () => {
    const client = makeClient();
    await client.connect();
    await client.connect(); // should not throw or reconnect
    expect(mockClientConnect).toHaveBeenCalledTimes(1);
  });

  it('throws MCPConnectionError when MCP handshake fails', async () => {
    mockClientConnect.mockRejectedValueOnce(new Error('handshake failed'));
    const client = makeClient();
    await expect(client.connect()).rejects.toThrow(MCPConnectionError);
  });

  it('close() is safe when not connected', async () => {
    const client = makeClient();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('close() disconnects and resets state', async () => {
    const client = makeClient();
    await client.connect();
    await client.close();
    // After close, close again should be a no-op (not throw)
    await expect(client.close()).resolves.toBeUndefined();
  });
});

// ─── registerTask ─────────────────────────────────────────────────────────────

describe('MCPKeeperClient — registerTask', () => {
  let mockFetch: jest.Mock;

  beforeEach(async () => {
    mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    (global as unknown as Record<string, unknown>).fetch = mockFetch;
    mockClientConnect.mockResolvedValue(undefined);
  });

  async function connectedClient() {
    const client = makeClient();
    await client.connect();
    return client;
  }

  it('throws MCPConnectionError when called before connect()', async () => {
    const client = makeClient();
    await expect(client.registerTask(VALID_TASK_PARAMS)).rejects.toThrow(
      MCPConnectionError,
    );
  });

  it('returns KeeperTaskRegistration on success', async () => {
    mockCallTool.mockResolvedValueOnce(
      makeToolResult({
        taskId:            'task-abc',
        scheduledFor:      1700000000,
        confirmedAt:       1699999900,
        estimatedGasLimit: 600000,
      }),
    );
    const client = await connectedClient();
    const reg = await client.registerTask(VALID_TASK_PARAMS);
    expect(reg.taskId).toBe('task-abc');
    expect(reg.scheduledFor).toBe(1700000000);
    expect(reg.confirmedAt).toBe(1699999900);
    expect(reg.estimatedGasLimit).toBe(600000);
  });

  it('defaults estimatedGasLimit to 600000 when absent from response', async () => {
    mockCallTool.mockResolvedValueOnce(
      makeToolResult({
        taskId:       'task-nogas',
        scheduledFor: 1700000000,
        confirmedAt:  1699999900,
      }),
    );
    const client = await connectedClient();
    const reg = await client.registerTask(VALID_TASK_PARAMS);
    expect(reg.estimatedGasLimit).toBe(600_000);
  });

  it('throws MCPToolError when callTool rejects', async () => {
    mockCallTool.mockRejectedValueOnce(new Error('network timeout'));
    const client = await connectedClient();
    await expect(client.registerTask(VALID_TASK_PARAMS)).rejects.toThrow(MCPToolError);
  });

  it('throws MCPToolError when result.isError is true', async () => {
    mockCallTool.mockResolvedValueOnce({
      isError: true,
      content: [{ text: 'something failed on server' }],
    });
    const client = await connectedClient();
    await expect(client.registerTask(VALID_TASK_PARAMS)).rejects.toThrow(MCPToolError);
  });

  it('throws MCPResponseParseError when response is not valid JSON', async () => {
    mockCallTool.mockResolvedValueOnce({
      isError: false,
      content: [{ text: 'not-json' }],
    });
    const client = await connectedClient();
    await expect(client.registerTask(VALID_TASK_PARAMS)).rejects.toThrow(
      MCPResponseParseError,
    );
  });

  it('throws MCPResponseParseError when taskId is missing', async () => {
    mockCallTool.mockResolvedValueOnce(
      makeToolResult({ scheduledFor: 1700000000, confirmedAt: 1699999900 }),
    );
    const client = await connectedClient();
    await expect(client.registerTask(VALID_TASK_PARAMS)).rejects.toThrow(
      MCPResponseParseError,
    );
  });

  it('throws MCPResponseParseError when scheduledFor is missing', async () => {
    mockCallTool.mockResolvedValueOnce(
      makeToolResult({ taskId: 'abc', confirmedAt: 1699999900 }),
    );
    const client = await connectedClient();
    await expect(client.registerTask(VALID_TASK_PARAMS)).rejects.toThrow(
      MCPResponseParseError,
    );
  });
});

// ─── getTaskStatus ────────────────────────────────────────────────────────────

describe('MCPKeeperClient — getTaskStatus', () => {
  let mockFetch: jest.Mock;

  beforeEach(async () => {
    mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    (global as unknown as Record<string, unknown>).fetch = mockFetch;
    mockClientConnect.mockResolvedValue(undefined);
  });

  async function connectedClient() {
    const client = makeClient();
    await client.connect();
    return client;
  }

  it('throws when taskId is empty', async () => {
    const client = await connectedClient();
    await expect(client.getTaskStatus('')).rejects.toThrow();
  });

  it('returns KeeperTaskStatusResult on success', async () => {
    mockCallTool.mockResolvedValueOnce(
      makeToolResult({
        taskId:       'task-x',
        status:       'scheduled',
        scheduledFor: 1700000000,
        retryCount:   0,
        lastAttemptAt: null,
        executionTxHash: null,
        lastError:    null,
      }),
    );
    const client = await connectedClient();
    const status = await client.getTaskStatus('task-x');
    expect(status.taskId).toBe('task-x');
    expect(status.status).toBe('scheduled');
    expect(status.retryCount).toBe(0);
  });

  it('throws MCPResponseParseError for unknown status value', async () => {
    mockCallTool.mockResolvedValueOnce(
      makeToolResult({
        taskId:       'task-x',
        status:       'alien_status',
        scheduledFor: 1700000000,
      }),
    );
    const client = await connectedClient();
    await expect(client.getTaskStatus('task-x')).rejects.toThrow(MCPResponseParseError);
  });

  it.each(['pending', 'scheduled', 'executing', 'completed', 'failed', 'cancelled'])(
    'accepts valid status "%s"',
    async (validStatus) => {
      mockCallTool.mockResolvedValueOnce(
        makeToolResult({
          taskId:       'task-y',
          status:       validStatus,
          scheduledFor: 1700000000,
        }),
      );
      const client = await connectedClient();
      const result = await client.getTaskStatus('task-y');
      expect(result.status).toBe(validStatus);
    },
  );
});

// ─── cancelTask ───────────────────────────────────────────────────────────────

describe('MCPKeeperClient — cancelTask', () => {
  let mockFetch: jest.Mock;

  beforeEach(async () => {
    mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    (global as unknown as Record<string, unknown>).fetch = mockFetch;
    mockClientConnect.mockResolvedValue(undefined);
  });

  async function connectedClient() {
    const client = makeClient();
    await client.connect();
    return client;
  }

  it('throws when taskId is empty', async () => {
    const client = await connectedClient();
    await expect(client.cancelTask('')).rejects.toThrow();
  });

  it('returns KeeperCancelResult on success', async () => {
    mockCallTool.mockResolvedValueOnce(
      makeToolResult({ taskId: 'task-z', success: true, cancelledAt: 1700000000 }),
    );
    const client = await connectedClient();
    const result = await client.cancelTask('task-z');
    expect(result.taskId).toBe('task-z');
    expect(result.success).toBe(true);
    expect(result.cancelledAt).toBe(1700000000);
  });

  it('defaults success=true when absent from response', async () => {
    mockCallTool.mockResolvedValueOnce(
      makeToolResult({ taskId: 'task-z' }),
    );
    const client = await connectedClient();
    const result = await client.cancelTask('task-z');
    expect(result.success).toBe(true);
  });
});

// ─── Error class shapes ───────────────────────────────────────────────────────

describe('MCPKeeperClient error classes', () => {
  it('MCPConnectionError has correct name and optional cause', () => {
    const cause = new Error('root');
    const e = new MCPConnectionError('conn failed', cause);
    expect(e.name).toBe('MCPConnectionError');
    expect(e.cause).toBe(cause);
    expect(e).toBeInstanceOf(Error);
  });

  it('MCPToolError includes toolName in message', () => {
    const e = new MCPToolError('my_tool', 'bad input');
    expect(e.name).toBe('MCPToolError');
    expect(e.toolName).toBe('my_tool');
    expect(e.message).toContain('my_tool');
  });

  it('MCPResponseParseError includes toolName in message', () => {
    const e = new MCPResponseParseError('register_task', 'missing field');
    expect(e.name).toBe('MCPResponseParseError');
    expect(e.toolName).toBe('register_task');
    expect(e.message).toContain('register_task');
  });
});
