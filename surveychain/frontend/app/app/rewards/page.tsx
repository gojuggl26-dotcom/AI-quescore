'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ethers } from 'ethers';
import Nav from '@/components/Nav';
import { connectWallet } from '@/lib/wallet';
import { fetchClaimableBalance, txWithdraw } from '@/lib/contract';
import { formatUsdc } from '@/lib/usdc';

const CONTRACT = process.env.NEXT_PUBLIC_SURVEY_REWARD_ADDRESS ?? '';

export default function MyRewards() {
  const router = useRouter();

  const [address,     setAddress]     = useState<string | null>(null);
  const [claimable,   setClaimable]   = useState<bigint | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [confirm,     setConfirm]     = useState(false);
  const [txHash,      setTxHash]      = useState<string | null>(null);
  const [error,       setError]       = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const { address: addr, provider } = await connectWallet();
      setAddress(addr);
      const raw = await fetchClaimableBalance(CONTRACT, addr, provider);
      setClaimable(raw);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWithdraw = useCallback(async () => {
    if (!address) return;
    setError(null);
    setWithdrawing(true);
    try {
      const { provider } = await connectWallet();
      const signer = await provider.getSigner();
      const receipt = await txWithdraw(CONTRACT, signer);
      setTxHash(receipt.hash);
      setClaimable(0n);
      setConfirm(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setWithdrawing(false);
    }
  }, [address]);

  const formatted = claimable !== null ? formatUsdc(claimable) : null;

  return (
    <>
      <Nav />
      <div className="wrap">
        <div className="subnav">
          <button className="snb" onClick={() => router.push('/app/explore')}>Explore</button>
          <button className="snb on">My Rewards</button>
        </div>

        <div className="ph">
          <h2>My Rewards</h2>
          <span className="ph-meta">Claimable Balance</span>
        </div>

        {error && <div className="banner banner-err">{error}</div>}
        {txHash && (
          <div className="banner banner-ok">
            Withdrawal successful! Tx: <span className="mono">{txHash.slice(0, 18)}…</span>
          </div>
        )}

        <div className="claim-box">
          <div style={{ fontSize: 10, color: '#fff', textTransform: 'uppercase', letterSpacing: '.5px' }}>
            Total Claimable Balance
          </div>

          {!address ? (
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-p" onClick={handleConnect} disabled={loading}>
                {loading ? <span className="spinner" /> : 'Connect Wallet to Check Balance'}
              </button>
            </div>
          ) : (
            <>
              <div className="claim-amt">
                {formatted ?? '—'} <span>USDC</span>
              </div>
              <div style={{ fontSize: 11, color: '#fff', marginBottom: 14 }}>
                Auto-confirmed after deadline · Batch withdrawal across surveys
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-p"
                  onClick={() => setConfirm(true)}
                  disabled={!claimable || claimable === 0n}
                >
                  Withdraw →
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    setLoading(true);
                    const { provider } = await connectWallet();
                    const raw = await fetchClaimableBalance(CONTRACT, address, provider);
                    setClaimable(raw);
                    setLoading(false);
                  }}
                  disabled={loading}
                >
                  {loading ? <span className="spinner" /> : 'Refresh'}
                </button>
              </div>
            </>
          )}
        </div>

        {confirm && (
          <div className="confirm-box">
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 10 }}>Confirm withdraw()</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 2, color: '#fff' }}>
              Amount: <span style={{ color: '#fff' }}>{formatted} USDC</span><br />
              Contract: <span style={{ color: '#fff' }}>{CONTRACT.slice(0, 10)}…</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                className="btn btn-p btn-s"
                onClick={handleWithdraw}
                disabled={withdrawing}
              >
                {withdrawing ? <span className="spinner" /> : 'Confirm & Withdraw'}
              </button>
              <button className="btn btn-s" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-h">
            <span className="card-t">Active Participations</span>
            <span style={{ fontSize: 10, color: '#fff' }}>pending · reward not yet confirmed</span>
          </div>
          <div style={{ padding: '14px 16px', fontSize: 12, color: '#fff', lineHeight: 1.7 }}>
            {address ? (
              <>
                KeeperHub will auto-execute distributeRewards() after each survey deadline and confirm
                your claimable balance.
                <br />
                <span style={{ fontSize: 10, color: '#fff' }}>
                  Quality scores and thresholds are never disclosed to respondents.
                </span>
                <div style={{ marginTop: 10 }}>
                  <button
                    className="btn btn-s"
                    onClick={() => router.push('/app/explore')}
                  >
                    Browse more surveys →
                  </button>
                </div>
              </>
            ) : (
              <span>Connect your wallet to see participation history.</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
