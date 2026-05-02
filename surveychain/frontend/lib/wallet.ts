'use client';

import { ethers } from 'ethers';

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

export async function connectWallet(): Promise<{ address: string; provider: ethers.BrowserProvider }> {
  if (!window.ethereum) throw new Error('MetaMask not detected. Please install MetaMask.');

  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  return { address, provider };
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export async function getSigner(provider: ethers.BrowserProvider): Promise<ethers.Signer> {
  return provider.getSigner();
}

export function onAccountsChanged(handler: (accounts: string[]) => void): () => void {
  if (!window.ethereum) return () => {};
  const wrapped = (accounts: unknown) => handler(accounts as string[]);
  window.ethereum.on('accountsChanged', wrapped);
  return () => window.ethereum?.removeListener('accountsChanged', wrapped);
}

export function onChainChanged(handler: () => void): () => void {
  if (!window.ethereum) return () => {};
  window.ethereum.on('chainChanged', handler);
  return () => window.ethereum?.removeListener('chainChanged', handler);
}
