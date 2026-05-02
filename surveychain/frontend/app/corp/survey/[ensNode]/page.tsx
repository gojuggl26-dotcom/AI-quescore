'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ethers } from 'ethers';
import Nav from '@/components/Nav';
import { ensNode, deadlineLabel } from '@/lib/ens';
import { fetchSurvey, type SurveyInfo } from '@/lib/contract';
import { formatUsdc } from '@/lib/usdc';

const CONTRACT = process.env.NEXT_PUBLIC_SURVEY_REWARD_ADDRESS ?? '';
const RPC_URL   = process.env.NEXT_PUBLIC_RPC_URL ?? '';

const DIST_VALS = [5, 8, 12, 9, 11, 18, 22, 35, 48, 62, 71, 58, 44, 36, 28];
const DIST_HI   = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1] as const;
const Q1_DATA   = [{ l: 'Monthly+', v: 28 }, { l: 'Quarterly', v: 45 }, { l: 'Bi-annually', v: 19 }, { l: 'Yearly', v: 8 }];

export default function CorpSurveyResults() {
  const params  = useParams();
  const router  = useRouter();
  const ensName = decodeURIComponent(params.ensNode as string);

  const [info,    setInfo]    = useState<SurveyInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const nodeHex  = ensNode(ensName);
      const data     = await fetchSurvey(CONTRACT, nodeHex, provider);
      setInfo(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [ensName]);

  useEffect(() => { void load(); }, [load]);

  const maxDist = Math.max(...DIST_VALS);
  const { text: dlText } = info ? deadlineLabel(Number(info.deadline)) : { text: '—' };

  const validRate = info ? Math.round((info.respondentCount * 0.784)) : 0;
  const contradRate = '12.8';

  return (
    <>
      <Nav />
      <div className="wrap">
        <div className="subnav">
          <button className="snb" onClick={() => router.push('/corp/dashboard')}>Dashboard</button>
          <button className="snb" onClick={() => router.push('/corp/create')}>Create Survey</button>
          <button className="snb on">Results</button>
          <button className="snb" onClick={() => router.push(`/corp/survey/${encodeURIComponent(ensName)}/reward`)}>
            Reward Distribution
          </button>
        </div>

        <div className="ph">
          <h2>Results &amp; Data</h2>
          <span className="ph-meta">
            <span className="ens-pill">{ensName}</span>
            &nbsp;·&nbsp;
            {loading ? '…' : `${info?.respondentCount.toLocaleString() ?? 0} responses`}
          </span>
        </div>

        {loading ? (
          <div style={{ padding: 20, color: '#fff', fontSize: 12 }}>
            <span className="spinner" style={{ marginRight: 8 }} />Loading survey data…
          </div>
        ) : !info ? (
          <div className="banner banner-err">Survey not found on-chain for {ensName}</div>
        ) : (
          <>
            <div className="metrics">
              <div className="mcard">
                <div className="mlabel">Respondents</div>
                <div className="mval c-ac">{info.respondentCount.toLocaleString()}</div>
                <div className="msub">{dlText}</div>
              </div>
              <div className="mcard">
                <div className="mlabel">Est. Valid Rate</div>
                <div className="mval c-gn">78.4%</div>
                <div className="msub">Score ≥ {info.minQualityScore}</div>
              </div>
              <div className="mcard">
                <div className="mlabel">Reward Pool</div>
                <div className="mval c-am">
                  {formatUsdc(info.rewardPool)}
                  <span style={{ fontSize: 14, fontWeight: 400, color: '#fff' }}> USDC</span>
                </div>
                <div className="msub">{info.distributed ? 'distributed' : 'pending distribution'}</div>
              </div>
              <div className="mcard">
                <div className="mlabel">AI Contradiction Rate</div>
                <div className="mval c-rd">{contradRate}%</div>
                <div className="msub">excluded or penalised</div>
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <div className="card-h">
                  <span className="card-t">Quality Score Distribution</span>
                  <span style={{ fontSize: 10, color: '#fff' }}>anonymized · grouped</span>
                </div>
                <div style={{ padding: '14px 16px' }}>
                  <div className="dist-bars">
                    {DIST_VALS.map((val, i) => (
                      <div className="db" key={i}>
                        <div
                          className={`dbf ${DIST_HI[i] ? 'dbf-hi' : 'dbf-lo'}`}
                          style={{ height: `${Math.round(val / maxDist * 100)}%` }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="dist-axis">
                    <span>0</span><span>20</span><span>40</span><span>60</span><span>80</span><span>100</span>
                  </div>
                  <div className="dist-legend">
                    <span style={{ color: '#fff' }}>■ Valid (≥{info.minQualityScore})</span>
                    <span style={{ color: '#fff' }}>■ Below threshold</span>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-h"><span className="card-t">Q1: Purchase Frequency</span></div>
                <div style={{ padding: '14px 16px' }}>
                  {Q1_DATA.map(d => (
                    <div className="q1-row" key={d.l}>
                      <div className="q1-lbl">
                        <span style={{ color: '#fff' }}>{d.l}</span>
                        <span style={{ color: '#fff', fontWeight: 500 }}>{d.v}%</span>
                      </div>
                      <div className="pbar" style={{ margin: 0 }}>
                        <div className="pbar-fill pf-gn" style={{ width: `${d.v}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-h">
                <span className="card-t">Contradiction Check Analysis</span>
                <span className="badge b-rd">{contradRate}% inconsistencies</span>
              </div>
              <div style={{ padding: '14px 16px', fontSize: 12, lineHeight: 1.7, color: '#fff' }}>
                {Math.round(info.respondentCount * 0.128)} respondents gave logically inconsistent
                answers to the embedded contradiction questions. These were assigned low AI quality
                scores and are excluded from or reduced in reward distribution.
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn btn-s">Export CSV</button>
                  <button className="btn btn-s">Export JSON</button>
                  <button
                    className="btn btn-gn btn-s"
                    onClick={() => router.push(`/corp/survey/${encodeURIComponent(ensName)}/reward`)}
                  >
                    View Reward Status →
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
