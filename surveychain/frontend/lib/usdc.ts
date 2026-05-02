import { ethers } from 'ethers';

const USDC_ABI = [
  'function balanceOf(address) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function nonces(address) external view returns (uint256)',
  'function name() external view returns (string)',
  'function version() external view returns (string)',
  'function DOMAIN_SEPARATOR() external view returns (bytes32)',
  'function allowance(address,address) external view returns (uint256)',
  'function approve(address,uint256) external returns (bool)',
];

export function getUsdcContract(
  address: string,
  signerOrProvider: ethers.Signer | ethers.Provider,
): ethers.Contract {
  return new ethers.Contract(address, USDC_ABI, signerOrProvider);
}

export async function getUsdcBalance(
  usdcAddress: string,
  walletAddress: string,
  provider: ethers.Provider,
): Promise<{ raw: bigint; formatted: string }> {
  const contract = getUsdcContract(usdcAddress, provider);
  const [raw, decimals] = await Promise.all([
    contract.balanceOf(walletAddress) as Promise<bigint>,
    contract.decimals() as Promise<bigint>,
  ]);
  const formatted = ethers.formatUnits(raw, decimals);
  return { raw, formatted };
}

export async function signUsdcPermit(
  usdcAddress: string,
  signer: ethers.Signer,
  spender: string,
  value: bigint,
  permitDeadline: bigint,
): Promise<{ v: number; r: string; s: string; deadline: bigint }> {
  const contract = getUsdcContract(usdcAddress, signer);
  const provider = signer.provider!;
  const network = await provider.getNetwork();

  const [name, version, domainSep, nonce] = await Promise.all([
    contract.name() as Promise<string>,
    contract.version().catch(() => '1') as Promise<string>,
    contract.DOMAIN_SEPARATOR() as Promise<string>,
    contract.nonces(await signer.getAddress()) as Promise<bigint>,
  ]);

  void domainSep;

  const domain = {
    name,
    version,
    chainId: network.chainId,
    verifyingContract: usdcAddress,
  };

  const types = {
    Permit: [
      { name: 'owner',    type: 'address' },
      { name: 'spender',  type: 'address' },
      { name: 'value',    type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };

  const message = {
    owner:    await signer.getAddress(),
    spender,
    value,
    nonce,
    deadline: permitDeadline,
  };

  const sig = await (signer as ethers.Wallet).signTypedData(domain, types, message);
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s, deadline: permitDeadline };
}

export function parseUsdc(amount: string, decimals = 6): bigint {
  return ethers.parseUnits(amount, decimals);
}

export function formatUsdc(raw: bigint, decimals = 6): string {
  return ethers.formatUnits(raw, decimals);
}
