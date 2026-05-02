'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ethers } from 'ethers';
import Nav from '@/components/Nav';
import { connectWallet } from '@/lib/wallet';
import { formatEnsNode } from '@/lib/ens';
import { fetchSurvey, txSubmitAnswer, fetchHasAnswered } from '@/lib/contract';
import { uploadAnswerData } from '@/lib/storage';
import { scoreAnswers } from '@/lib/compute';
import { fetchQuestions, type QuestionItem } from '@/lib/storage';
import type { QuestionAnswer, AnswerData } from '@agent/types';

const CONTRACT = process.env.NEXT_PUBLIC_SURVEY_REWARD_ADDRESS ?? '';
const RPC_URL   = process.env.NEXT_PUBLIC_RPC_URL ?? '';

type PipeStage = 'idle' | 'uploading' | 'scoring' | 'submitting' | 'done' | 'error';

export default function AnswerSurvey() {
  const params  = useParams();
  const router  = useRouter();
  const ensName = decodeURIComponent(params.ensNode as string);
  const ensNodeHex = formatEnsNode(ensName);

  const [questions,   setQuestions]   = useState<QuestionItem[]>([]);
  const [answers,     setAnswers]     = useState<Map<string, number[]>>(new Map());
  const [textAnswers, setTextAnswers] = useState<Map<string, string>>(new Map());
  const [timestamps,  setTimestamps]  = useState<number[]>([]);
  const [curQ,        setCurQ]        = useState(0);
  const [loading,     setLoading]     = useState(true);
  const [address,     setAddress]     = useState<string | null>(null);
  const [provider,    setProvider]    = useState<ethers.BrowserProvider | null>(null);
  const [pipe,        setPipe]        = useState<PipeStage>('idle');
  const [error,       setError]       = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const qStartRef = useRef<number>(Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ethProvider = new ethers.JsonRpcProvider(RPC_URL);
      const info = await fetchSurvey(CONTRACT, ensNodeHex, ethProvider);
      if (!info) { setError('Survey not found'); return; }

      const qs = await fetchQuestions(info.questionCID).catch(() => null);
      if (!qs || qs.length === 0) {
        setError('Failed to load questions from 0G Storage');
        return;
      }
      setQuestions(qs);
      setTimestamps(new Array(qs.length).fill(0));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [ensNodeHex]);

  useEffect(() => { void load(); }, [load]);

  const connectAndCheck = useCallback(async () => {
    try {
      const { address: addr, provider: prov } = await connectWallet();
      setAddress(addr);
      setProvider(prov);
      const ethProvider = new ethers.JsonRpcProvider(RPC_URL);
      const done = await fetchHasAnswered(CONTRACT, ensNodeHex, addr, ethProvider);
      setAlreadyDone(done);
    } catch (err) {
      console.error(err);
    }
  }, [ensNodeHex]);

  const selectChoice = (qId: string, idx: number, multi: boolean) => {
    setAnswers(prev => {
      const next = new Map(prev);
      if (multi) {
        const existing = next.get(qId) ?? [];
        next.set(qId, existing.includes(idx) ? existing.filter(i => i !== idx) : [...existing, idx]);
      } else {
        next.set(qId, [idx]);
      }
      return next;
    });
    const ts = new Array(questions.length).fill(0);
    ts[curQ] = Date.now() - qStartRef.current;
    setTimestamps(ts);
  };

  const goNext = useCallback(async () => {
    if (curQ < questions.length - 1) {
      qStartRef.current = Date.now();
      setCurQ(c => c + 1);
      return;
    }

    if (!address || !provider) {
      await connectAndCheck();
      return;
    }

    setError(null);
    setPipe('uploading');
    try {
      const builtAnswers: QuestionAnswer[] = questions.map((q, i) => ({
        questionId: q.id,
        type: q.type,
        choices: answers.get(q.id),
        text: q.type === 'text' ? textAnswers.get(q.id) : undefined,
        contradictionPairId: q.contradictionPairId,
        totalChoices: q.options?.length,
      }));

      const answerData: AnswerData = {
        ensNode: ensNodeHex as `0x${string}`,
        respondent: address as `0x${string}`,
        answers: builtAnswers,
        timestamps,
        cid: '',
      };

      const { cid } = await uploadAnswerData(answerData, address);
      answerData.cid = cid;

      setPipe('scoring');
      const result = await scoreAnswers(answerData, address);

      setPipe('submitting');
      const signer = await provider.getSigner();
      await txSubmitAnswer(CONTRACT, signer, result.payload);

      setPipe('done');
      setTimeout(() => router.push('/app/rewards'), 2000);
    } catch (err) {
      setError(String(err));
      setPipe('error');
    }
  }, [curQ, questions, answers, textAnswers, timestamps, address, provider, ensNodeHex, connectAndCheck, router]);

  const progress = questions.length > 0 ? Math.round(((curQ + 1) / questions.length) * 100) : 0;
  const q = questions[curQ];

  const pipeLabels: Record<PipeStage, string> = {
    idle:       '',
    uploading:  '1. Uploading to 0G Storage…',
    scoring:    '2. AI Quality Scoring (TEE)…',
    submitting: '3. Submitting on-chain…',
    done:       '✓ Submitted! Redirecting…',
    error:      '⚠ Error',
  };

  return (
    <>
      <Nav />
      <div className="wrap">
        <div className="subnav">
          <button className="snb" onClick={() => router.push('/app/explore')}>Explore</button>
          <button className="snb on">Answer Survey</button>
          <button className="snb" onClick={() => router.push('/app/rewards')}>My Rewards</button>
        </div>

        {loading ? (
          <div style={{ padding: 20, color: '#fff', fontSize: 12 }}>
            <span className="spinner" style={{ marginRight: 8 }} />Loading survey…
          </div>
        ) : error && !q ? (
          <div className="banner banner-err">{error}</div>
        ) : alreadyDone ? (
          <div className="banner banner-ok">You have already answered this survey.</div>
        ) : q ? (
          <>
            <div className="ph">
              <h2>Answer Survey</h2>
              <span className="ph-meta" id="qa-meta">
                {ensName} · Q{curQ + 1} of {questions.length}
              </span>
            </div>

            <div style={{ height: 2, background: 'var(--bg3)', borderRadius: 2, marginBottom: 20 }}>
              <div style={{ height: '100%', background: 'var(--ac)', borderRadius: 2, transition: 'width .3s', width: `${progress}%` }} />
            </div>

            <div className="card" style={{ padding: 20, marginBottom: 14, overflow: 'visible' }}>
              <div style={{ fontSize: 10, color: '#fff', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
                Question {curQ + 1} of {questions.length}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--tx)', marginBottom: 16, lineHeight: 1.4 }}>
                {q.text}
              </div>

              {q.type === 'text' ? (
                <textarea
                  placeholder="Your answer…"
                  value={textAnswers.get(q.id) ?? ''}
                  onChange={e => setTextAnswers(prev => new Map(prev).set(q.id, e.target.value))}
                  style={{ minHeight: 80 }}
                />
              ) : (
                <div className="opts">
                  {(q.options ?? []).map((opt, i) => {
                    const sel = (answers.get(q.id) ?? []).includes(i);
                    return (
                      <div
                        key={i}
                        className={`opt${sel ? ' sel' : ''}`}
                        onClick={() => selectChoice(q.id, i, q.type === 'multiple_choice')}
                      >
                        <div className="opt-circle" />
                        <span>{opt}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {pipe !== 'idle' && (
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--bd)', borderRadius: 10, padding: '12px 15px', marginBottom: 14 }}>
                <div style={{ fontSize: 10, color: '#fff', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
                  Submission Pipeline
                </div>
                <div className="flow-steps">
                  {(['uploading', 'scoring', 'submitting', 'done'] as PipeStage[]).map((s, i) => (
                    <span
                      key={s}
                      className={`badge ${
                        pipe === s ? 'b-ac'
                        : ['done', 'submitting', 'scoring', 'uploading'].indexOf(pipe) > ['done', 'submitting', 'scoring', 'uploading'].indexOf(s)
                          ? 'b-gn' : 'b-gr'
                      }`}
                    >
                      {i + 1}. {s === 'uploading' ? 'AES-256-GCM Encrypt + Upload' : s === 'scoring' ? 'AI Quality Scoring (TEE)' : s === 'submitting' ? 'On-chain Submit' : 'Done'}
                    </span>
                  ))}
                </div>
                {pipe !== 'idle' && (
                  <div style={{ fontSize: 11, color: pipe === 'error' ? '#ef4444' : '#fff', marginTop: 4 }}>
                    {pipe === 'error' ? error : pipeLabels[pipe]}
                  </div>
                )}
              </div>
            )}

            {!address && curQ === questions.length - 1 && (
              <div className="banner banner-warn">
                Connect your wallet before submitting.
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button
                className="btn"
                onClick={() => { setCurQ(c => Math.max(0, c - 1)); }}
                disabled={curQ === 0 || pipe !== 'idle'}
              >
                ← Previous
              </button>
              <button
                className="btn btn-p"
                onClick={goNext}
                disabled={pipe !== 'idle' && pipe !== 'error'}
              >
                {pipe !== 'idle' && pipe !== 'error'
                  ? <span className="spinner" />
                  : curQ === questions.length - 1
                    ? (address ? 'Submit' : 'Connect & Submit')
                    : 'Next →'
                }
              </button>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
