/**
 * x402 payment protocol handler (Coinbase x402 v2 / EIP-3009).
 *
 * Flow
 * ────
 * 1. Caller makes an HTTP request; server responds with 402.
 * 2. Parse the 402 body as an X402Challenge.
 * 3. Choose the best Accept option (prefer "exact" over "upto").
 * 4. Sign an EIP-3009 transferWithAuthorization message with the agent wallet.
 * 5. Encode the signed payment as Base64 JSON → X-PAYMENT header.
 * 6. Retry the original request with the header attached.
 */
import { Wallet, Signature } from 'ethers';
import { randomBytes } from 'crypto';
import type { HexString } from './types';
import type {
  Eip3009Authorization,
  X402Accept,
  X402Challenge,
  X402Payment,
} from './KeeperTypes';

// ─── Errors ───────────────────────────────────────────────────────────────────

export class X402Error extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'X402Error';
  }
}

export class X402PaymentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402PaymentRejectedError';
  }
}

// ─── EIP-3009 type definition ─────────────────────────────────────────────────

/**
 * EIP-3009 transferWithAuthorization EIP-712 types.
 * USDC (Circle) implements this standard on all major chains.
 */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
} as const;

// ─── X402Handler ──────────────────────────────────────────────────────────────

export class X402Handler {
  constructor(
    private readonly signer: Wallet,
    /** EVM chain ID of the payment network (used in EIP-712 domain). */
    private readonly paymentChainId: number,
    /** USDC contract address on the payment network. */
    private readonly usdcAddress: HexString,
  ) {}

  /**
   * Parses an HTTP 402 response body as an X402Challenge.
   * Throws X402Error when the response body is malformed or version-incompatible.
   */
  async parseChallenge(response: Response): Promise<X402Challenge> {
    if (response.status !== 402) {
      throw new X402Error(
        `Expected HTTP 402 but got ${response.status}`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new X402Error(
        `Failed to parse 402 response body as JSON: ${String(err)}`,
        402,
        err,
      );
    }

    return this.validateChallenge(body);
  }

  /**
   * Signs an EIP-3009 transferWithAuthorization for the best Accept option
   * and returns the encoded X-PAYMENT header value (Base64 JSON).
   */
  async buildPaymentHeader(challenge: X402Challenge): Promise<string> {
    const accept = this.selectBestAccept(challenge.accepts);
    const authorization = await this.signEip3009(accept);
    const payment: X402Payment = {
      scheme:  accept.scheme,
      network: accept.network,
      payload: authorization,
    };
    return Buffer.from(JSON.stringify(payment), 'utf8').toString('base64');
  }

  /**
   * Executes a fetch request, automatically handling a single 402 challenge.
   * On success, returns the final Response.
   * Throws X402Error if payment is rejected or a second 402 is received.
   */
  async fetchWithPayment(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    // First attempt (no payment header)
    const first = await fetch(url, init);
    if (first.status !== 402) return first;

    // Handle payment challenge
    const challenge = await this.parseChallenge(first);
    const paymentHeader = await this.buildPaymentHeader(challenge);

    const second = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'X-PAYMENT': paymentHeader,
      },
    });

    if (second.status === 402) {
      throw new X402PaymentRejectedError(
        `KeeperHub rejected the x402 payment for URL=${url}. ` +
          `The signed authorization may have expired or the amount was insufficient.`,
      );
    }

    return second;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private selectBestAccept(accepts: X402Accept[]): X402Accept {
    if (!accepts || accepts.length === 0) {
      throw new X402Error('x402 challenge contains no "accepts" entries');
    }
    // Prefer "exact" scheme (predictable cost) over "upto"
    const exact = accepts.find((a) => a.scheme === 'exact');
    return exact ?? accepts[0]!;
  }

  private async signEip3009(
    accept: X402Accept,
  ): Promise<Eip3009Authorization> {
    const from     = await this.signer.getAddress();
    const to       = accept.payTo;
    const value    = accept.maxAmountRequired;
    // nonce is a random bytes32 — protects against replay attacks
    const nonce    = ('0x' + randomBytes(32).toString('hex')) as HexString;
    const now      = Math.floor(Date.now() / 1000);
    // validBefore: now + maxTimeoutSeconds (or 1 hour, whichever is smaller)
    const validBefore = String(now + Math.min(accept.maxTimeoutSeconds, 3600));
    const validAfter  = '0';

    const domain = {
      name:              'USD Coin',    // USDC EIP-712 domain name
      version:           '2',
      chainId:           this.paymentChainId,
      verifyingContract: this.usdcAddress,
    };

    const message = {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
    };

    let signature: string;
    try {
      signature = await this.signer.signTypedData(
        domain,
        TRANSFER_WITH_AUTHORIZATION_TYPES,
        message,
      );
    } catch (err) {
      throw new X402Error(
        `Failed to sign EIP-3009 authorization: ${String(err)}`,
        undefined,
        err,
      );
    }

    // Split into r, s, v components
    const sig = Signature.from(signature);

    return {
      from:        from as HexString,
      to:          to as HexString,
      value,
      validAfter,
      validBefore,
      nonce,
      v: sig.v,
      r: sig.r as HexString,
      s: sig.s as HexString,
    };
  }

  private validateChallenge(raw: unknown): X402Challenge {
    if (typeof raw !== 'object' || raw === null) {
      throw new X402Error(`x402 challenge must be an object, got ${typeof raw}`);
    }
    const obj = raw as Record<string, unknown>;

    if (typeof obj['version'] !== 'number') {
      throw new X402Error('x402 challenge missing "version" field');
    }
    if (!Array.isArray(obj['accepts']) || obj['accepts'].length === 0) {
      throw new X402Error('x402 challenge missing or empty "accepts" array');
    }

    const accepts: X402Accept[] = [];
    for (const [i, item] of (obj['accepts'] as unknown[]).entries()) {
      if (typeof item !== 'object' || item === null) {
        throw new X402Error(`x402 accepts[${i}] must be an object`);
      }
      const a = item as Record<string, unknown>;
      const required = [
        'scheme',
        'network',
        'maxAmountRequired',
        'resource',
        'payTo',
        'maxTimeoutSeconds',
        'asset',
      ] as const;
      for (const key of required) {
        if (!(key in a)) {
          throw new X402Error(`x402 accepts[${i}] missing required field "${key}"`);
        }
      }
      if (a['scheme'] !== 'exact' && a['scheme'] !== 'upto') {
        throw new X402Error(
          `x402 accepts[${i}].scheme must be "exact" or "upto", got "${String(a['scheme'])}"`,
        );
      }
      accepts.push({
        scheme:             a['scheme'] as 'exact' | 'upto',
        network:            String(a['network']),
        maxAmountRequired:  String(a['maxAmountRequired']),
        resource:           String(a['resource']),
        description:        String(a['description'] ?? ''),
        mimeType:           String(a['mimeType'] ?? 'application/json'),
        payTo:              String(a['payTo']),
        maxTimeoutSeconds:  Number(a['maxTimeoutSeconds']),
        asset:              a['asset'] as HexString,
      });
    }

    return { version: obj['version'] as number, accepts };
  }
}
