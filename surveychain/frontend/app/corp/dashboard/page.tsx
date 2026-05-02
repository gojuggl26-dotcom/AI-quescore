'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ethers } from 'ethers';
import Nav from '@/components/Nav';
import { connectWallet } from '@/lib/wallet';
import { ensNode } from '@/lib/ens';
import { fetchSurvey, fetchClaimableBalance, type SurveyInfo } from '@/lib/contract';
import { formatUsdc } from '@/lib/usdc';

const CONTRACT = process.env.NEXT_PUBLIC_SURVEY_REWARD_ADDRESS ?? '';
const USDC_ADDR = process.env.NEXT_PUBLIC_USDC_ADDRESS ?? '';
const RPC_URL   = process.env.NEXT_PUBLIC_RPC_URL ?? '';

interface SurveyRow {
  ensName:     string;
  ensNodeHex:  string;
  info:        SurveyInfo;
  status:      'active' | 'pending' | 'settled';
}

const DEMO_ENS_NAMES = ['nike-q3-survey.eth', 'nike-brand-survey.eth', 'nike-product-q2.eth'];

export default function CorpDashboard() {
  const router = useRouter();

  const [surveys,    setSurveys]    = useState<SurveyRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [totalPool,  setTotalPool]  = useState('0');
  const [claimable,  setClaimable]  = useState('0');
  const [address,    setAddress]    = useState<string | null>(null);

  const getProvider = useCallback(() => {
    return new ethers.JsonRpcProvider(RPC_URL);
  }, []);

  const loadSurveys = useCallback(async () => {
    setLoading(true);
    try {
      const provider = getProvider();
      const rows: SurveyRow[] = [];
      let poolTotal = 0n;

      for (const name of DEMO_ENS_NAMES) {
        const nodeHex = ensNode(name);
        const info = await fetchSurvey(CONTRACT, nodeHex, provider);
        if (!info) continue;
        const now = BigInt(Math.floor(Date.now() / 1000));
        const status: SurveyRow['status'] =
          info.distributed ? 'settled'
          : info.deadline < now ? 'pending'
          : 'active';
        rows.push({ ensName: name, ensNodeHex: nodeHex, info, status });
        poolTotal += info.rewardPool;
      }

      setSurveys(rows);
      setTotalPool(formatUsdc(poolTotal));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [getProvider]);

  useEffect(() => { void loadSurveys(); }, [loadSurveys]);

  const handleConnectForClaimable = useCallback(async () => {
    try {
      const { address: addr, provider } = await connectWallet();
      setAddress(addr);
      const raw = await fetchClaimableBalance(CONTRACT, addr, provider);
      setClaimable(formatUsdc(raw));
    } catch (err) {
      console.error(err);
    }
  }, []);

  const activeCount  = surveys.filter(s => s.status === 'active').length;
  const validRate    = '78.4';

  return (
    <>
      <Nav />
      <div className="wrap">
        <div className="subnav">
          <button className="snb on">Dashboard</button>
          <button className="snb" onClick={() => router.push('/corp/create')}>Create Survey</button>
        </div>

        <div className="ph">
          <h2>Dashboard</h2>
          <span className="ph-meta">Sepolia Testnet</span>
        </div>

        <div className="metrics">
          <div className="mcard">
            <div className="mlabel">Active Surveys</div>
            <div className="mval c-ac">{loading ? '—' : activeCount}</div>
            <div className="msub">on-chain</div>
          </div>
          <div className="mcard">
            <div className="mlabel">Valid Response Rate</div>
            <div className="mval c-gn">{validRate}%</div>
            <div className="msub">Score ≥ threshold</div>
          </div>
          <div className="mcard">
            <div className="mlabel">Total Reward Pool</div>
            <div className="mval c-am">
              {loading ? '—' : totalPool} <span style={{ fontSize: 14, fontWeight: 400, color: '#fff' }}>USDC</span>
            </div>
            <div className="msub">across all surveys</div>
          </div>
          <div className="mcard">
            <div className="mlabel">
              {address ? 'My Claimable' : 'Your Rewards'}
            </div>
            {address ? (
              <div className="mval c-gn">
                {claimable} <span style={{ fontSize: 14, fontWeight: 400, color: '#fff' }}>USDC</span>
              </div>
            ) : (
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-s btn-p" onClick={handleConnectForClaimable}>
                  Connect to check
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <span className="card-t">Surveys</span>
            <button className="btn btn-p btn-s" onClick={() => router.push('/corp/create')}>
              + New Survey
            </button>
          </div>
          {loading ? (
            <div style={{ padding: '20px 14px', color: '#fff', fontSize: 12 }}>
              <span className="spinner" style={{ marginRight: 8 }} />Loading…
            </div>
          ) : surveys.length === 0 ? (
            <div style={{ padding: '20px 14px', color: '#fff', fontSize: 12 }}>
              No surveys found.{' '}
              <button
                className="btn btn-s btn-p"
                onClick={() => router.push('/corp/create')}
                style={{ marginLeft: 8 }}
              >
                Create one
              </button>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 185 }}>ENS Domain</th>
                  <th>Respondents</th>
                  <th style={{ width: 115 }}>Pool</th>
                  <th style={{ width: 115 }}>Deadline</th>
                  <th style={{ width: 95 }}>Status</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {surveys.map(row => (
                  <tr
                    key={row.ensNodeHex}
                    onClick={() => router.push(`/corp/survey/${encodeURIComponent(row.ensName)}`)}
                  >
                    <td><span className="ens-pill">{row.ensName}</span></td>
                    <td>{row.info.respondentCount.toLocaleString()}</td>
                    <td className="c-gn mono">{formatUsdc(row.info.rewardPool)} USDC</td>
                    <td className="mono" style={{ color: '#fff' }}>
                      {new Date(Number(row.info.deadline) * 1000).toLocaleDateString()}
                    </td>
                    <td>
                      {row.status === 'active'  && <span className="badge b-gn">✓ active</span>}
                      {row.status === 'pending' && <span className="badge b-am">⏳ pending</span>}
                      {row.status === 'settled' && <span className="badge b-gr">✓ settled</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn btn-s"
                        onClick={e => {
                          e.stopPropagation();
                          router.push(`/corp/survey/${encodeURIComponent(row.ensName)}`);
                        }}
                      >
                        {row.status === 'pending' ? 'Status' : 'Details'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
