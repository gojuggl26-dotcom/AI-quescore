declare module '@0glabs/0g-ts-sdk' {
  import type { Signer } from 'ethers';

  export interface InferenceService {
    requestWithAttestation(modelName: string, prompt: string): Promise<unknown>;
  }

  export class ZGComputeNetworkBroker {
    constructor(computeUrl: string, signer: Signer);
    static initialize(signer: ethers.Signer): Promise<ZGComputeNetworkBroker>;
    readonly inference: InferenceService;
    infer(serviceAccount: string, content: string, fee: bigint): Promise<string>;
    settleFee(serviceAccount: string, amount: bigint): Promise<void>;
  }

  export class ZgFile {
    static fromFilePath(path: string): Promise<ZgFile>;
    static fromBuffer(buffer: Buffer, fileType?: string): Promise<ZgFile>;
    merkleTree(): Promise<{ rootHash: () => string }>;
    close(): void;
  }

  export class Indexer {
    constructor(rpc: string);
    upload(file: ZgFile, rpc: string, signer: Signer): Promise<[string | null, Error | null]>;
    download(rootHash: string, outputPath: string, proof: boolean): Promise<Error | null>;
  }
}
