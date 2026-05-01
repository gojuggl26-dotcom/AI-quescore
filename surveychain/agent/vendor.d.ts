// Minimal type declarations for ethers and @0glabs/0g-ts-sdk.
// Replace this file with the real packages by running: npm install
declare module 'ethers' {
  export interface Signer {}

  export class BaseProvider {}

  export class EnsResolver {
    getText(key: string): Promise<string | null>;
  }

  export class JsonRpcProvider extends BaseProvider {
    constructor(url: string);
    getResolver(name: string): Promise<EnsResolver | null>;
  }

  export class Wallet implements Signer {
    constructor(privateKey: string, provider?: BaseProvider);
    signMessage(message: string | Uint8Array): Promise<string>;
    getAddress(): Promise<string>;
    signTypedData(
      domain: Record<string, unknown>,
      types: Record<string, unknown>,
      value: Record<string, unknown>,
    ): Promise<string>;
  }

  export class Interface {
    constructor(fragments: string[]);
    encodeFunctionData(name: string, args: unknown[]): string;
  }

  export class Signature {
    static from(sig: string): Signature;
    v: number;
    r: string;
    s: string;
  }

  export function ensNormalize(name: string): string;
  export function namehash(name: string): string;
  export function getBytes(value: string): Uint8Array;
  export function concat(values: Uint8Array[]): Uint8Array;
  export function toUtf8Bytes(text: string): Uint8Array;
  export function keccak256(data: Uint8Array | string): string;
}

declare module '@0glabs/0g-ts-sdk' {
  import type { Signer } from 'ethers';

  interface InferenceService {
    requestWithAttestation(modelName: string, prompt: string): Promise<unknown>;
  }

  export class ZGComputeNetworkBroker {
    readonly inference: InferenceService;
    constructor(computeUrl: string, signer: Signer);
  }
}
