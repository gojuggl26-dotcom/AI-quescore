'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ethers } from 'ethers';
import Nav from '@/components/Nav';
import { connectWallet } from '@/lib/wallet';
import { ensNode, deadlineLabel } from '@/lib/ens';
import { fetchSurvey, fetchHasAnswered, type SurveyInfo } from '@/lib/contract';
import { formatUsdc } from '@/lib/usdc';

const CONTRACT = process.env.NEXT_PUBLIC_SURVEY_REWARD_ADDRESS ?? '';
const RPC_URL   = process.env.NEXT_PUBLIC_RPC_URL ?? '';

const SURVEY_NAMES = [
  'nike-q3-survey.eth',
  'toyota-ev-survey.eth',
  'sony-music-feedback.eth',
];

interface SurveyCard {
  ensName:     string;
  ensNodeHex:  string;
  info:        SurveyInfo;
  answered:    boolean;
  deadline:    { text: string; expired: boolean };
}

export default function Explore() {
  const router = useRouter();

  const [cards,    setCards]    = useState<SurveyCard[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [address,  setAddress]  = useState<string | null>(null);
  const [search,   setSearch]   = useState('');

  const loadSurveys = useCallback(async (addr: string | null) => {
    setLoading(true);
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const results: SurveyCard[] = [];
      for (const name of SURVEY_NAMES) {
        const nodeHex = ensNode(name);
        const info = await fetchSurvey(CONTRACT, nodeHex, provider);
        if (!info) continue;
        const answered = addr
          ? await fetchHasAnswered(CONTRACT, nodeHex, addr, provider)
          : false;
        results.push({
          ensName: name,
          ensNodeHex: nodeHex,
          info,
          answered,
          deadline: deadlineLabel(Number(info.deadline)),
        });
      }
      setCards(results);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSurveys(null); }, [loadSurveys]);

  const handleConnect = useCallback(async () => {
    try {
      const { address: addr } = await connectWallet();
      setAddress(addr);
      await loadSurveys(addr);
    } catch (err) {
      console.error(err);
    }
  }, [loadSurveys]);

  const filtered = cards.filter(c =>
    !search ||
    c.ensName.includes(search.toLowerCase())
  );

  return (
    <>
      <Nav />
      <div className="wrap">
        <div className="subnav">
          <button className="snb on">Explore</button>
          <button className="snb" onClick={() => router.push('/app/rewards')}>My Rewards</button>
        </div>

        <div className="ph">
          <h2>Explore Surveys</h2>
          <span className="ph-meta">{filtered.length} surveys</span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Search by ENS name…"
            style={{ maxWidth: 280 }}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {!address && (
            <button className="btn btn-p btn-s" onClick={handleConnect}>
              Connect Wallet to track status
            </button>
          )}
        </div>

        {loading ? (
          <div style={{ color: '#fff', fontSize: 12 }}>
            <span className="spinner" style={{ marginRight: 8 }} />Loading surveys…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ color: '#fff', fontSize: 12 }}>No surveys found.</div>
        ) : (
          <div className="sc-grid">
            {filtered.map(c => (
              <div
                key={c.ensNodeHex}
                className="sc"
                style={{ opacity: c.answered ? 0.6 : 1 }}
                onClick={() => !c.answered && router.push(`/app/survey/${encodeURIComponent(c.ensName)}`)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <div>
                    <div className="sc-ens">{c.ensName}</div>
                    <div className="sc-title">{c.info.questionCID ? 'Survey' : c.ensName.split('.')[0]}</div>
                  </div>
                  {c.answered
                    ? <span className="badge b-gr">Answered</span>
                    : c.deadline.expired
                      ? <span className="badge b-gr">Expired</span>
                      : <span className="badge b-gn">✓ active</span>
                  }
                </div>

                <div className="sc-pool">
                  {formatUsdc(c.info.rewardPool)} <span>USDC pool</span>
                </div>
                <div className="pbar">
                  <div
                    className="pbar-fill pf-gn"
                    style={{ width: `${Math.min(100, (c.info.respondentCount / 1000) * 100)}%` }}
                  />
                </div>
                <div className="sc-meta">
                  <span>{c.info.respondentCount.toLocaleString()} responses</span>
                  <span>{c.deadline.text}</span>
                  <span>~5 min</span>
                </div>

                {!c.answered && !c.deadline.expired && (
                  <button
                    className="btn btn-p btn-s"
                    style={{ width: '100%', marginTop: 10 }}
                    onClick={e => { e.stopPropagation(); router.push(`/app/survey/${encodeURIComponent(c.ensName)}`); }}
                  >
                    Answer →
                  </button>
                )}
                {c.answered && (
                  <button className="btn btn-s" style={{ width: '100%', marginTop: 10 }} disabled>
                    Already answered
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
