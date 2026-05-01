declare module 'ethers' {
  export class JsonRpcProvider {
    constructor(url?: string);
  }

  export class Wallet {
    constructor(privateKey: string, provider?: JsonRpcProvider);
    readonly address: string;
  }

  export namespace ethers {
    type Signer = Wallet;
  }

  export type Signer = Wallet;
}
