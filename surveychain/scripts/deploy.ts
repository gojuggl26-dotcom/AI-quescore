import * as dotenv from 'dotenv';
dotenv.config();
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join } from 'path';

async function main() {
  const usdc                = requireEnv('USDC_ADDRESS');
  const keeperHub           = requireEnv('KEEPER_HUB_ADDRESS');
  const ensRegistry         = process.env.ENS_REGISTRY_ADDRESS
    ?? '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
  const zgAttestationSigner = requireEnv('ZG_ATTESTATION_SIGNER');
  const rpcUrl              = requireEnv('SEPOLIA_RPC_URL');
  const rawKey   = requireEnv('DEPLOYER_PRIVATE_KEY');
  const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(privateKey, provider);

  console.log('Deploying with:', wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log('Balance:', ethers.formatEther(balance), 'ETH');

  // Load compiled artifact
  const artifactPath = join(__dirname, '../artifacts/contracts/SurveyReward.sol/SurveyReward.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi: any[]; bytecode: string };

  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(usdc, keeperHub, ensRegistry, zgAttestationSigner);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log('\nSurveyReward deployed to:', address);
  console.log('Add to .env.local:\n  NEXT_PUBLIC_SURVEY_REWARD_ADDRESS=' + address);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
