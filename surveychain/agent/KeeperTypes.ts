import type { HexString } from './types';

// ─── Task lifecycle ────────────────────────────────────────────────────────────

export type KeeperTaskStatus =
  | 'pending'     // registered, not yet confirmed by KeeperHub
  | 'scheduled'   // confirmed; waiting for triggerTimestamp
  | 'executing'   // KeeperHub is submitting the on-chain tx
  | 'completed'   // tx confirmed; distributeRewards() succeeded
  | 'failed'      // all retries exhausted
  | 'cancelled';  // cancelled before execution

export type GasStrategy   = 'dynamic' | 'fixed';
export type RoutingStrategy = 'private' | 'public';
export type PaymentMethod   = 'x402' | 'mpp';

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Input to KeeperRegistrationAgent.execute().
 * Provide the raw ENS name; the agent resolves deadline and ensNode.
 */
export interface KeeperRegistrationInput {
  /** Raw ENS name as set in ENS Text Records, e.g. "mysurvey.eth". */
  ensName: string;
  /** Deployed SurveyReward.sol contract address on the target chain. */
  contractAddress: HexString;
  /** EVM chain ID (1 = mainnet, 11155111 = sepolia). */
  chainId: number;
}

/**
 * Parameters sent to the KeeperHub MCP `register_keeper_task` tool.
 * All values are derived deterministically from KeeperRegistrationInput.
 */
export interface KeeperTaskParams {
  /** bytes32 ENS namehash — identifies the survey in SurveyReward.sol. */
  ensNode: HexString;
  /** SurveyReward.sol address (target of the keeper call). */
  contractAddress: HexString;
  /** ABI-encoded calldata for distributeRewards(bytes32 ensNode). */
  calldata: HexString;
  /** Unix timestamp (seconds) at which KeeperHub must fire the call. */
  triggerTimestamp: number;
  chainId: number;
  /** Maximum retries on execution failure (network congestion etc.). */
  retries: 10;
  /** Dynamic gas: KeeperHub waits for favourable base-fee windows. */
  gasStrategy: 'dynamic';
  /** Private mempool routing (Flashbots / Titan) to prevent MEV front-running. */
  routing: 'private';
  /** Payment method for autonomous agent billing. */
  paymentMethod: 'x402';
}

/**
 * Response from the KeeperHub MCP `register_keeper_task` tool.
 */
export interface KeeperTaskRegistration {
  /** Opaque task identifier issued by KeeperHub. Persist this for status queries. */
  taskId: string;
  /** Same as KeeperTaskParams.triggerTimestamp — echoed for verification. */
  scheduledFor: number;
  /** Unix timestamp when KeeperHub confirmed the registration. */
  confirmedAt: number;
  /** KeeperHub's estimated gas limit (informational). */
  estimatedGasLimit: number;
}

/**
 * Output returned by KeeperRegistrationAgent.execute().
 */
export interface KeeperRegistrationOutput {
  taskId: string;
  ensNode: HexString;
  ensName: string;
  /** Normalised ENS name (ENSIP-15). */
  normalizedName: string;
  /** Unix timestamp (seconds) of survey.deadline resolved from ENS. */
  triggerTimestamp: number;
  /** Unix timestamp when KeeperHub confirmed the task. */
  scheduledAt: number;
}

// ─── Task status ──────────────────────────────────────────────────────────────

export interface KeeperTaskStatusResult {
  taskId: string;
  status: KeeperTaskStatus;
  scheduledFor: number;
  lastAttemptAt: number | null;
  /** On-chain tx hash of distributeRewards() if already executed. */
  executionTxHash: HexString | null;
  retryCount: number;
  /** Error message from the most recent failed attempt, or null. */
  lastError: string | null;
}

export interface KeeperCancelResult {
  taskId: string;
  success: boolean;
  cancelledAt: number;
}

// ─── x402 payment ─────────────────────────────────────────────────────────────

/**
 * Challenge object parsed from the HTTP 402 response body.
 * Based on the Coinbase x402 protocol v2.
 */
export interface X402Accept {
  scheme: 'exact' | 'upto';
  /** Network identifier, e.g. "base-mainnet", "ethereum-mainnet". */
  network: string;
  /** Maximum amount in asset's smallest units (e.g. USDC 6-decimal micro-units). */
  maxAmountRequired: string;
  /** URL of the resource being accessed (used in the signed message). */
  resource: string;
  description: string;
  mimeType: string;
  /** KeeperHub wallet address that receives the USDC payment. */
  payTo: string;
  /** Seconds until the challenge expires. */
  maxTimeoutSeconds: number;
  /** ERC-20 token address for payment (typically USDC). */
  asset: HexString;
}

export interface X402Challenge {
  version: number;
  accepts: X402Accept[];
}

/**
 * EIP-3009 transferWithAuthorization payload signed by the agent wallet.
 * USDC (and most Circle stablecoins) support this standard, allowing the
 * recipient to pull payment without a pre-approval.
 */
export interface Eip3009Authorization {
  from:        HexString;
  to:          HexString;
  value:       string;      // uint256 as decimal string
  validAfter:  string;      // uint256 as decimal string (0 = immediately valid)
  validBefore: string;      // uint256 as decimal string (deadline seconds)
  nonce:       HexString;   // bytes32 random nonce
  v: number;
  r: HexString;
  s: HexString;
}

export interface X402Payment {
  scheme: 'exact' | 'upto';
  network: string;
  payload: Eip3009Authorization;
}

// ─── Agent configuration ──────────────────────────────────────────────────────

export interface KeeperAgentConfig {
  /** KeeperHub MCP server HTTP endpoint, e.g. "https://keeperhub.io/mcp". */
  mcpEndpoint: string;
  /** EVM JSON-RPC URL for ENS resolution (mainnet for production). */
  evmRpcUrl: string;
  /** Agent wallet private key — signs x402 USDC payment authorizations. */
  privateKey: HexString;
  /**
   * USDC contract address on the chain used for x402 payments.
   * Must match the chain where KeeperHub expects payment.
   */
  usdcAddress: HexString;
  /**
   * EVM chain ID for x402 payment (may differ from the chain where
   * distributeRewards() will be called — e.g. pay on Base, execute on mainnet).
   */
  paymentChainId: number;
}
