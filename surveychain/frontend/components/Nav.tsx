'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { connectWallet, shortAddress, onAccountsChanged, onChainChanged } from '@/lib/wallet';

export default function Nav() {
  const router   = useRouter();
  const pathname = usePathname();

  const [address,     setAddress]     = useState<string | null>(null);
  const [drawerOpen,  setDrawerOpen]  = useState(false);
  const [connecting,  setConnecting]  = useState(false);

  const handleConnect = useCallback(async () => {
    if (connecting) return;
    if (address) { setAddress(null); return; }
    setConnecting(true);
    try {
      const { address: addr } = await connectWallet();
      setAddress(addr);
    } catch (err) {
      console.error(err);
    } finally {
      setConnecting(false);
    }
  }, [address, connecting]);

  useEffect(() => {
    const off1 = onAccountsChanged((accounts) => {
      setAddress(accounts[0] ?? null);
    });
    const off2 = onChainChanged(() => window.location.reload());
    return () => { off1(); off2(); };
  }, []);

  const go = (path: string) => {
    router.push(path);
    setDrawerOpen(false);
  };

  const isOn = (path: string) => pathname === path || pathname.startsWith(path + '/');

  const closeDrawer = () => setDrawerOpen(false);

  return (
    <>
      <nav>
        <div className="logo" style={{ cursor: 'pointer' }} onClick={() => go('/corp/dashboard')}>
          Que<b>score</b>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className={`wallet-btn${address ? ' connected' : ''}`}
            onClick={handleConnect}
            disabled={connecting}
          >
            {address && <span className="wdot" />}
            <span>
              {connecting ? 'Connecting…' : address ? shortAddress(address) : 'Connect Wallet'}
            </span>
          </button>
          <button
            className={`hbg${drawerOpen ? ' open' : ''}`}
            onClick={() => setDrawerOpen(!drawerOpen)}
            aria-label="Menu"
          >
            <span /><span /><span />
          </button>
        </div>
      </nav>

      <div
        className={`drawer-overlay${drawerOpen ? ' open' : ''}`}
        onClick={closeDrawer}
      />

      <div className={`drawer${drawerOpen ? ' open' : ''}`}>
        <div className="drawer-head">
          <h3>Navigation</h3>
          <button className="drawer-close" onClick={closeDrawer}>&#215;</button>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-label">Corporate Portal</div>
          <button
            className={`drawer-item${isOn('/corp/dashboard') ? ' on' : ''}`}
            onClick={() => go('/corp/dashboard')}
          >
            <div className="di-icon">&#9635;</div>Dashboard
          </button>
          <button
            className={`drawer-item${isOn('/corp/create') ? ' on' : ''}`}
            onClick={() => go('/corp/create')}
          >
            <div className="di-icon">&#43;</div>Create Survey
          </button>
          <button
            className={`drawer-item${pathname.includes('/corp/survey') && !pathname.includes('/reward') ? ' on' : ''}`}
            onClick={() => go('/corp/dashboard')}
          >
            <div className="di-icon">&#9636;</div>Results &amp; Data
          </button>
          <button
            className={`drawer-item${pathname.includes('/reward') ? ' on' : ''}`}
            onClick={() => go('/corp/dashboard')}
          >
            <div className="di-icon">&#9672;</div>Reward Distribution
          </button>
        </div>

        <div className="drawer-div" />

        <div className="drawer-section">
          <div className="drawer-section-label">User App</div>
          <button
            className={`drawer-item${isOn('/app/explore') ? ' on' : ''}`}
            onClick={() => go('/app/explore')}
          >
            <div className="di-icon">&#9733;</div>Explore Surveys
          </button>
          <button
            className={`drawer-item${pathname.includes('/app/survey') ? ' on' : ''}`}
            onClick={() => go('/app/explore')}
          >
            <div className="di-icon">&#9998;</div>Answer Survey
          </button>
          <button
            className={`drawer-item${isOn('/app/rewards') ? ' on' : ''}`}
            onClick={() => go('/app/rewards')}
          >
            <div className="di-icon">&#9670;</div>My Rewards
          </button>
        </div>

        <div style={{ marginTop: 'auto', padding: '16px 20px', borderTop: '1px solid var(--bd)' }}>
          <div style={{ fontSize: 10, color: '#fff', marginBottom: 6 }}>Network</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#fff' }}>
            <span className="wdot" />Ethereum Sepolia Testnet
          </div>
        </div>
      </div>
    </>
  );
}
