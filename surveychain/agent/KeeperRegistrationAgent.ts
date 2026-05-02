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

const PRE_TRIGGER_BUFFER_SECONDS = 30;

const MIN_DEADLINE_MARGIN_SECONDS = 300;

const KEEPER_FIXED_PARAMS = {
  retries:       10 as const,
  gasStrategy:   'dynamic' as const,
  routing:       'private' as const,
  paymentMethod: 'x402' as const,
} as const;

const DISTRIBUTE_REWARDS_FRAGMENT =
  'function distributeRewards(bytes32 ensNode)';

const ENS_DEADLINE_KEY = 'survey.deadline';

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

  async execute(
    input: KeeperRegistrationInput,
  ): Promise<KeeperRegistrationOutput> {
    this.validateInput(input);

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

    const triggerTimestamp = await this.resolveDeadline(normalizedName);

    const calldata = this.encodeDistributeRewards(ensNode);

    const taskParams: KeeperTaskParams = {
      ensNode,
      contractAddress: input.contractAddress,
      calldata,
      triggerTimestamp: triggerTimestamp - PRE_TRIGGER_BUFFER_SECONDS,
      chainId:          input.chainId,
      ...KEEPER_FIXED_PARAMS,
    };

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
      await mcpClient.close().catch((err: unknown) => {
        console.warn(
          `[KeeperRegistrationAgent] MCP close error (non-fatal): ${String(err)}`,
        );
      });
    }

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

  private encodeDistributeRewards(ensNode: HexString): HexString {
    const iface = new Interface([DISTRIBUTE_REWARDS_FRAGMENT]);
    return iface.encodeFunctionData('distributeRewards', [ensNode]) as HexString;
  }

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
