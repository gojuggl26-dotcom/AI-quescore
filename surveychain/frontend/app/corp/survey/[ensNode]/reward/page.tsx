'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ethers } from 'ethers';
import Nav from '@/components/Nav';
import { ensNode, deadlineLabel } from '@/lib/ens';
import { fetchSurvey, getSurveyRewardContract, type SurveyInfo } from '@/lib/contract';
import { formatUsdc } from '@/lib/usdc';

const CONTRACT = process.env.NEXT_PUBLIC_SURVEY_REWARD_ADDRESS ?? '';
const RPC_URL   = process.env.NEXT_PUBLIC_RPC_URL ?? '';

type DistStage = 'Active' | 'Closed' | 'Distributing' | 'Distributed' | 'Settled';

interface KeeperEvent {
  title: string;
  sub:   string;
  icon:  string;
  color: string;
}

export default function CorpRewardDistribution() {
  const params  = useParams();
  const router  = useRouter();
  const ensName = decodeURIComponent(params.ensNode as string);

  const [info,     setInfo]     = useState<SurveyInfo | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [events,   setEvents]   = useState<KeeperEvent[]>([]);
  const [claimed,  setClaimed]  = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const nodeHex  = ensNode(ensName);
      const data     = await fetchSurvey(CONTRACT, nodeHex, provider);
      setInfo(data);

      if (data) {
        const contract = getSurveyRewardContract(CONTRACT, provider);
        const filter = contract.filters.RewardClaimed?.();
        if (filter) {
          const logs = await contract.queryFilter(filter, -10000);
          setClaimed(logs.length);
        }

        const keeperFilter = contract.filters.RewardsDistributed?.(nodeHex);
        if (keeperFilter) {
          const distLogs = await contract.queryFilter(keeperFilter, -10000);
          const ev: KeeperEvent[] = distLogs.map(log => ({
            title: 'distributeRewards() succeeded',
            sub:   `Block #${log.blockNumber.toLocaleString()} · via KeeperHub`,
            icon:  '✓',
            color: 'var(--gnl)',
          }));
          setEvents(ev.length > 0 ? ev : [
            { title: 'Keeper registered', sub: 'Immediately after createSurvey()', icon: '●', color: 'var(--gnl)' },
          ]);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [ensName]);

  useEffect(() => { void load(); }, [load]);

  const stage: DistStage = !info ? 'Active'
    : !info.distributed && Number(info.deadline) > Date.now() / 1000 ? 'Active'
    : !info.distributed ? 'Closed'
    : 'Distributed';

  const stages: DistStage[] = ['Active', 'Closed', 'Distributing', 'Distributed', 'Settled'];
  const { text: dlText } = info ? deadlineLabel(Number(info.deadline)) : { text: '—' };

  const reserved = info ? (Number(formatUsdc(info.rewardPool)) * 0.68).toFixed(2) : '0';
  const undistributed = info ? (Number(formatUsdc(info.rewardPool)) * 0.32).toFixed(2) : '0';

  return (
    <>
      <Nav />
      <div className="wrap">
        <div className="subnav">
          <button className="snb" onClick={() => router.push('/corp/dashboard')}>Dashboard</button>
          <button className="snb" onClick={() => router.push('/corp/create')}>Create Survey</button>
          <button className="snb" onClick={() => router.push(`/corp/survey/${encodeURIComponent(ensName)}`)}>
            Results
          </button>
          <button className="snb on">Reward Distribution</button>
        </div>

        <div className="ph">
          <h2>Reward Distribution</h2>
          <span className="ph-meta">
            <span className="ens-pill">{ensName}</span>&nbsp;·&nbsp;USDC
          </span>
        </div>

        {loading ? (
          <div style={{ padding: 20, color: '#fff', fontSize: 12 }}>
            <span className="spinner" style={{ marginRight: 8 }} />Loading…
          </div>
        ) : !info ? (
          <div className="banner banner-err">Survey not found: {ensName}</div>
        ) : (
          <>
            <div className="two-col">
              <div className="claim-box">
                <div style={{ fontSize: 10, color: '#fff', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                  Reward Pool Balance
                </div>
                <div className="claim-amt">
                  {formatUsdc(info.rewardPool)} <span>USDC</span>
                </div>
                <div className="pbar">
                  <div className="pbar-fill pf-gn" style={{ width: '68%' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#fff' }}>
                  <span>Reserved: {reserved} USDC</span>
                  <span>Undistributed: {undistributed} USDC</span>
                </div>
                <div style={{ marginTop: 12, fontSize: 11, color: '#fff' }}>
                  {dlText} · Min score: {info.minQualityScore}
                </div>
              </div>

              <div className="card" style={{ marginBottom: 0 }}>
                <div className="card-h"><span className="card-t">KeeperHub Execution Log</span></div>
                <div style={{ padding: '0 16px' }}>
                  {events.length === 0 ? (
                    <div style={{ padding: '14px 0', fontSize: 12, color: '#fff' }}>
                      No execution events yet. KeeperHub will trigger after deadline.
                    </div>
                  ) : events.map((ev, i) => (
                    <div className="tl-item" key={i}>
                      <div className="tl-icon" style={{ background: ev.color, color: '#fff' }}>
                        {ev.icon}
                      </div>
                      <div>
                        <div className="tl-title">{ev.title}</div>
                        <div className="tl-sub">{ev.sub}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-h">
                <span className="card-t">Distribution Status</span>
                <span className={`badge ${info.distributed ? 'b-gn' : 'b-am'}`}>
                  {info.distributed ? '✓ distributed' : '⏳ pending'}
                </span>
              </div>
              <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: '#fff', marginBottom: 8, fontFamily: 'monospace' }}>
                    ACTIVE → CLOSED → DISTRIBUTING → DISTRIBUTED → SETTLED
                  </div>
                  <div className="status-pipe">
                    {stages.map(s => (
                      <div key={s} className={`sp-item${s === stage ? ' cur' : ''}`}>{s}</div>
                    ))}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: '#fff' }}>Users withdrawn</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>
                    {claimed}
                    <span style={{ fontSize: 12, fontWeight: 400, color: '#fff' }}>
                      {' '}/ {info.respondentCount}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
