/**
 * Keeper registration agent — OpenClaw-compatible entry point.
 *
 * Orchestration flow
 * ──────────────────
 * 1. Validate input (ensName, contractAddress, chainId).
 * 2. Normalize ENS name (ENSIP-15) and compute bytes32 namehash (ensNode).
 * 3. Resolve `survey.deadline` Text Record from ENS via ethers provider.
 * 4. Encode distributeRewards(ensNode) calldata via ABI encoder.
 * 5. Connect to KeeperHub MCP server (x402 pre-auth).
 * 6. Register keeper task with:
 *      trigger.type   = timestamp (ENS survey.deadline)
 *      retries        = 10
 *      gasStrategy    = dynamic
 *      routing        = private (Flashbots/Titan MEV protection)
 *      paymentMethod  = x402
 * 7. Return confirmed registration including taskId and scheduledFor.
 *
 * Fallback design (SEC-07)
 * ─────────────────────────
 * The SurveyReward.sol `onlyKeeperOrFallback` modifier provides a secondary
 * execution path: if KeeperHub fails to execute distributeRewards() and
 * `deadline + FALLBACK_DELAY (7 days)` passes, the contract owner can call
 * distributeRewards() directly.  This agent's role is only the registration
 * step; the fallback is enforced on-chain.
 *
 * The agent also registers the task triggerTimestamp slightly before the
 * on-chain deadline (by `PRE_TRIGGER_BUFFER_SECONDS`) so KeeperHub can
 * prepare the transaction and have it confirmed at or shortly after deadline.
 */
import {
  JsonRpcProvider,
  Wallet,
  Interface,
  ensNormalize,
  namehash,
  type EnsResolver,
}                                         from 'ethers';
import type {
  IOpenClawAgent,
  HexString,
}                                         from './types';
import { MCPKeeperClient }               from './MCPKeeperclient';
import type {
  KeeperAgentConfig,
  KeeperRegistrationInput,
  KeeperRegistrationOutput,
  KeeperTaskParams,
}                                         from './KeeperTypes';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Seconds before the on-chain deadline at which KeeperHub should target
 * inclusion of the distributeRewards() transaction.
 *
 * The contract enforces `block.timestamp >= deadline`, so the tx must NOT
 * confirm before deadline.  KeeperHub uses dynamic gas to aim for inclusion
 * at [deadline, deadline + 60s].  We trigger slightly early so KeeperHub has
 * time to build and broadcast the tx.
 */
const PRE_TRIGGER_BUFFER_SECONDS = 30;

/**
 * Minimum seconds in the future a survey.deadline must be for a keeper task
 * to be useful.  Deadlines within this window are already past or too close.
 */
const MIN_DEADLINE_MARGIN_SECONDS = 300; // 5 minutes

/**
 * Fixed parameters that mirror the SurveyReward.sol + spec requirements.
 * These are NOT configurable per-call; they are part of the system contract.
 */
const KEEPER_FIXED_PARAMS = {
  retries:       10 as const,
  gasStrategy:   'dynamic' as const,
  routing:       'private' as const,
  paymentMethod: 'x402' as const,
} as const;

/**
 * Minimal ABI fragment for distributeRewards — used only for calldata encoding.
 * The full contract ABI is not needed here.
 */
const DISTRIBUTE_REWARDS_FRAGMENT =
  'function distributeRewards(bytes32 ensNode)';

/**
 * ENS Text Record key for the survey deadline (mirrors ENS_TEXT_KEYS.deadline
 * in frontend/ens/ensUtils.ts — kept in sync manually).
 */
const ENS_DEADLINE_KEY = 'survey.deadline';

// ─── Errors ───────────────────────────────────────────────────────────────────

export class KeeperInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeeperInputValidationError';
  }
}

export class ENSResolutionError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ENSResolutionError';
  }
}

export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

// ─── KeeperRegistrationAgent ──────────────────────────────────────────────────

export class KeeperRegistrationAgent
  implements IOpenClawAgent<KeeperRegistrationInput, KeeperRegistrationOutput>
{
  readonly name        = 'KeeperRegistrationAgent';
  readonly description =
    'Registers a distributeRewards() keeper task with KeeperHub via MCP. ' +
    'Reads the survey deadline from ENS Text Records and schedules on-chain ' +
    'execution with private routing, dynamic gas, and x402 autonomous payment.';
  readonly version = '1.0.0';

  private readonly provider: JsonRpcProvider;
  private readonly signer:   Wallet;

  constructor(private readonly config: KeeperAgentConfig) {
    this.validateConfig(config);
    this.provider = new JsonRpcProvider(config.evmRpcUrl);
    this.signer   = new Wallet(config.privateKey, this.provider);
  }

  // ─── IOpenClawAgent ──────────────────────────────────────────────────────────

  async execute(
    input: KeeperRegistrationInput,
  ): Promise<KeeperRegistrationOutput> {
    this.validateInput(input);

    // ── Step 1: Normalize ENS name and compute namehash ──────────────────────
    let normalizedName: string;
    let ensNode: HexString;
    try {
      normalizedName = ensNormalize(input.ensName.trim().toLowerCase());
      ensNode        = namehash(normalizedName) as HexString;
    } catch (err) {
      throw new KeeperInputValidationError(
        `ENS name "${input.ensName}" failed ENSIP-15 normalisation: ${String(err)}`,
      );
    }

    // ── Step 2: Resolve survey.deadline from ENS ─────────────────────────────
    const triggerTimestamp = await this.resolveDeadline(normalizedName);

    // ── Step 3: Encode distributeRewards calldata ────────────────────────────
    const calldata = this.encodeDistributeRewards(ensNode);

    // ── Step 4: Build keeper task params ────────────────────────────────────
    const taskParams: KeeperTaskParams = {
      ensNode,
      contractAddress: input.contractAddress,
      calldata,
      // KeeperHub targets inclusion at triggerTimestamp; subtract buffer so
      // the tx is broadcast before deadline and confirmed at/after it.
      triggerTimestamp: triggerTimestamp - PRE_TRIGGER_BUFFER_SECONDS,
      chainId:          input.chainId,
      ...KEEPER_FIXED_PARAMS,
    };

    // ── Step 5: Connect to KeeperHub and register task ───────────────────────
    const mcpClient = new MCPKeeperClient(
      this.config.mcpEndpoint,
      this.signer,
      this.config.paymentChainId,
      this.config.usdcAddress,
    );

    let registration: Awaited<ReturnType<MCPKeeperClient['registerTask']>>;
    try {
      await mcpClient.connect();
      registration = await mcpClient.registerTask(taskParams);
    } finally {
      // Always close the connection, even if registration throws.
      await mcpClient.close().catch((err: unknown) => {
        console.warn(
          `[KeeperRegistrationAgent] MCP close error (non-fatal): ${String(err)}`,
        );
      });
    }

    // ── Step 6: Verify the registration matches what we requested ───────────
    if (registration.scheduledFor !== taskParams.triggerTimestamp) {
      console.warn(
        `[KeeperRegistrationAgent] KeeperHub scheduled task at ` +
          `${registration.scheduledFor} but requested ` +
          `${taskParams.triggerTimestamp}. Proceeding.`,
      );
    }

    return {
      taskId:           registration.taskId,
      ensNode,
      ensName:          input.ensName,
      normalizedName,
      triggerTimestamp,
      scheduledAt:      registration.confirmedAt,
    };
  }

  getCapabilities(): string[] {
    return [
      'ens-deadline-resolution',
      'keeperhub-mcp-registration',
      'x402-autonomous-payment',
      'eip3009-usdc-authorization',
      'private-mempool-routing',
      'dynamic-gas-strategy',
      'distribute-rewards-scheduling',
      'openclaw-compatible',
    ];
  }

  // ─── ENS resolution ───────────────────────────────────────────────────────────

  /**
   * Resolves the `survey.deadline` Text Record from ENS for the given name.
   * Uses ethers v6 provider's built-in ENS support.
   *
   * The deadline value must be a valid future Unix timestamp (seconds).
   * Timestamps within MIN_DEADLINE_MARGIN_SECONDS of now are rejected to
   * prevent keeper tasks that would fire before the tx could confirm.
   *
   * @param normalizedName Already ENSIP-15 normalised ENS name.
   * @returns Deadline as a Unix timestamp in seconds.
   */
  private async resolveDeadline(normalizedName: string): Promise<number> {
    let resolver: EnsResolver | null;
    try {
      resolver = await this.provider.getResolver(normalizedName);
    } catch (err) {
      throw new ENSResolutionError(
        `Failed to fetch ENS resolver for "${normalizedName}": ${String(err)}`,
        err,
      );
    }

    if (!resolver) {
      throw new ENSResolutionError(
        `No ENS resolver is set for "${normalizedName}". ` +
          `Ensure the domain is registered and a resolver is configured.`,
      );
    }

    let deadlineRaw: string | null;
    try {
      deadlineRaw = await resolver.getText(ENS_DEADLINE_KEY);
    } catch (err) {
      throw new ENSResolutionError(
        `Failed to read Text Record "${ENS_DEADLINE_KEY}" from resolver for ` +
          `"${normalizedName}": ${String(err)}`,
        err,
      );
    }

    if (!deadlineRaw || deadlineRaw.trim() === '') {
      throw new ENSResolutionError(
        `ENS Text Record "${ENS_DEADLINE_KEY}" is not set for "${normalizedName}". ` +
          `Create the survey first (set survey.deadline via ENS Text Record update).`,
      );
    }

    const deadlineTs = parseInt(deadlineRaw.trim(), 10);
    if (!Number.isInteger(deadlineTs) || deadlineTs <= 0) {
      throw new ENSResolutionError(
        `ENS Text Record "${ENS_DEADLINE_KEY}" for "${normalizedName}" is not a ` +
          `valid Unix timestamp: "${deadlineRaw}"`,
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const margin     = deadlineTs - nowSeconds;

    if (margin < MIN_DEADLINE_MARGIN_SECONDS) {
      throw new DeadlineError(
        `Survey deadline for "${normalizedName}" is too close or in the past: ` +
          `deadline=${deadlineTs} now=${nowSeconds} margin=${margin}s ` +
          `(minimum required: ${MIN_DEADLINE_MARGIN_SECONDS}s). ` +
          `Keeper registration is not useful for near-expired surveys.`,
      );
    }

    return deadlineTs;
  }

  // ─── Calldata encoding ────────────────────────────────────────────────────────

  /**
   * ABI-encodes the distributeRewards(bytes32) call using ethers Interface.
   * The resulting hex calldata is sent to KeeperHub, which submits it as
   * the transaction data when calling the SurveyReward contract.
   */
  private encodeDistributeRewards(ensNode: HexString): HexString {
    const iface = new Interface([DISTRIBUTE_REWARDS_FRAGMENT]);
    return iface.encodeFunctionData('distributeRewards', [ensNode]) as HexString;
  }

  // ─── Validation ───────────────────────────────────────────────────────────────

  private validateConfig(config: KeeperAgentConfig): void {
    const required: Array<keyof KeeperAgentConfig> = [
      'mcpEndpoint',
      'evmRpcUrl',
      'privateKey',
      'usdcAddress',
      'paymentChainId',
    ];
    for (const key of required) {
      if (!config[key]) {
        throw new Error(`KeeperRegistrationAgent: config.${key} is required`);
      }
    }
    try {
      new URL(config.mcpEndpoint);
    } catch {
      throw new Error(
        `KeeperRegistrationAgent: config.mcpEndpoint is not a valid URL: "${config.mcpEndpoint}"`,
      );
    }
    if (!Number.isInteger(config.paymentChainId) || config.paymentChainId <= 0) {
      throw new Error(
        `KeeperRegistrationAgent: config.paymentChainId must be a positive integer`,
      );
    }
  }

  private validateInput(input: KeeperRegistrationInput): void {
    if (!input) {
      throw new KeeperInputValidationError('input is null or undefined');
    }
    if (typeof input.ensName !== 'string' || input.ensName.trim() === '') {
      throw new KeeperInputValidationError(
        'input.ensName must be a non-empty string',
      );
    }
    if (!input.ensName.trim().includes('.')) {
      throw new KeeperInputValidationError(
        `input.ensName "${input.ensName}" does not look like a valid ENS name (missing dot)`,
      );
    }
    if (
      typeof input.contractAddress !== 'string' ||
      !input.contractAddress.startsWith('0x') ||
      input.contractAddress.length !== 42
    ) {
      throw new KeeperInputValidationError(
        `input.contractAddress must be a 20-byte hex address (0x + 40 hex chars), ` +
          `got: "${input.contractAddress}"`,
      );
    }
    if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
      throw new KeeperInputValidationError(
        `input.chainId must be a positive integer, got: ${input.chainId}`,
      );
    }
  }
}
