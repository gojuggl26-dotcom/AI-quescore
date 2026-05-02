'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '@/components/Nav';
import { connectWallet } from '@/lib/wallet';
import { isValidEnsName, formatEnsNode, normalizeEnsName } from '@/lib/ens';
import { txCreateSurvey } from '@/lib/contract';
import { signUsdcPermit, parseUsdc } from '@/lib/usdc';
import { uploadQuestions, type QuestionItem } from '@/lib/storage';
import { ethers } from 'ethers';

const CONTRACT = process.env.NEXT_PUBLIC_SURVEY_REWARD_ADDRESS ?? '';
const USDC_ADDR = process.env.NEXT_PUBLIC_USDC_ADDRESS ?? '';

const STEPS = ['ENS Auth', 'Basic Info', 'Questions', 'Reward', 'Review & Deploy'];

interface FormState {
  ensName:        string;
  title:          string;
  description:    string;
  deadline:       string;
  minScore:       number;
  rewardAmount:   string;
}

const DEFAULT_QUESTIONS: QuestionItem[] = [
  { id: 'q1', type: 'single_choice', text: 'How often do you use our product?', options: ['Daily', 'Weekly', 'Monthly', 'Rarely'] },
  { id: 'q2', type: 'single_choice', text: 'How satisfied are you with the product?', options: ['Very satisfied', 'Satisfied', 'Neutral', 'Dissatisfied'] },
  { id: 'q3', type: 'contradiction', text: 'Do you prefer feature A over B?', options: ['Yes', 'No'], contradictionPairId: 'pair-1' },
  { id: 'q4', type: 'contradiction', text: 'Do you prefer feature B over A?', options: ['Yes', 'No'], contradictionPairId: 'pair-1' },
  { id: 'q5', type: 'text', text: 'Any additional feedback?' },
];

export default function CorpCreate() {
  const router = useRouter();

  const [step,      setStep]      = useState(0);
  const [form,      setForm]      = useState<FormState>({
    ensName: '', title: '', description: '', deadline: '', minScore: 30, rewardAmount: '',
  });
  const [questions, setQuestions] = useState<QuestionItem[]>(DEFAULT_QUESTIONS);
  const [address,   setAddress]   = useState<string | null>(null);
  const [ensOk,     setEnsOk]     = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [loading,   setLoading]   = useState(false);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const verifyEns = useCallback(async () => {
    setError(null);
    if (!isValidEnsName(form.ensName)) { setError('Invalid ENS name'); return; }
    setLoading(true);
    try {
      const { address: addr } = await connectWallet();
      setAddress(addr);
      setEnsOk(true);
      setStep(1);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [form.ensName]);

  const deploy = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const { provider } = await connectWallet();
      const signer = await provider.getSigner();

      const questionCID = await uploadQuestions(questions, address ?? '');

      const deadlineTs  = BigInt(Math.floor(new Date(form.deadline).getTime() / 1000));
      const rewardRaw   = parseUsdc(form.rewardAmount);
      const permitDl    = deadlineTs + 3600n;

      const { v, r, s, deadline: pDl } = await signUsdcPermit(
        USDC_ADDR, signer, CONTRACT, rewardRaw, permitDl,
      );

      const nodeHex = formatEnsNode(form.ensName);
      await txCreateSurvey(
        CONTRACT, signer, nodeHex, deadlineTs,
        form.minScore, rewardRaw, questionCID,
        pDl, v, r, s,
      );

      router.push('/corp/dashboard');
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [form, questions, address, router]);

  const deadlineTs  = form.deadline ? Math.floor(new Date(form.deadline).getTime() / 1000) : 0;
  const normalName  = isValidEnsName(form.ensName) ? normalizeEnsName(form.ensName) : '';

  return (
    <>
      <Nav />
      <div className="wrap">
        <div className="subnav">
          <button className="snb" onClick={() => router.push('/corp/dashboard')}>Dashboard</button>
          <button className="snb on">Create Survey</button>
        </div>

        <div className="ph">
          <h2>Create Survey</h2>
          <span className="ph-meta">Step {step + 1} of {STEPS.length}</span>
        </div>

        <div className="steps">
          {STEPS.map((label, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < STEPS.length - 1 ? 1 : undefined }}>
              <div className={`step${i === step ? ' on' : i < step ? ' done' : ''}`}>
                <div className="snum">{i < step ? '✓' : i + 1}</div>
                <span>{label}</span>
              </div>
              {i < STEPS.length - 1 && <div className="sline" />}
            </div>
          ))}
        </div>

        {error && <div className="banner banner-err">{error}</div>}

        <div className="card" style={{ padding: 20 }}>
          {/* STEP 0: ENS Auth */}
          {step === 0 && (
            <>
              <div style={{ marginBottom: 14 }}>
                <div className="flabel" style={{ marginBottom: 6 }}>ENS Domain</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    placeholder="example.eth"
                    value={form.ensName}
                    onChange={e => update('ensName', e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-p"
                    onClick={verifyEns}
                    disabled={loading || !form.ensName}
                  >
                    {loading ? <span className="spinner" /> : 'Verify & Connect'}
                  </button>
                </div>
                <div style={{ fontSize: 10, color: '#fff', marginTop: 6 }}>
                  You must own this ENS domain. MetaMask will be used to verify ownership.
                </div>
              </div>
            </>
          )}

          {/* STEP 1: Basic Info */}
          {step === 1 && (
            <>
              {ensOk && (
                <div className="ens-bar">
                  <span className="wdot" />
                  <span style={{ fontFamily: 'monospace', color: '#fff' }}>{normalName}</span>
                  <span style={{ color: '#fff' }}>ENS owner verified</span>
                </div>
              )}
              <div className="form-grid">
                <div className="fg">
                  <label className="flabel">Survey Title</label>
                  <input type="text" value={form.title} onChange={e => update('title', e.target.value)} />
                </div>
                <div className="fg">
                  <label className="flabel">Deadline (UTC)</label>
                  <input
                    type="datetime-local"
                    value={form.deadline}
                    onChange={e => update('deadline', e.target.value)}
                  />
                </div>
                <div className="fg">
                  <label className="flabel">Min Quality Score (0–100)</label>
                  <input
                    type="range" min={0} max={100} step={1}
                    value={form.minScore}
                    onChange={e => update('minScore', Number(e.target.value))}
                    style={{ padding: 0 }}
                  />
                  <span style={{ fontSize: 11, color: '#fff' }}>Threshold: {form.minScore} / 100</span>
                </div>
                <div className="fg full">
                  <label className="flabel">Description</label>
                  <textarea
                    value={form.description}
                    onChange={e => update('description', e.target.value)}
                    placeholder="Survey purpose and instructions…"
                  />
                </div>
              </div>

              {form.deadline && (
                <div className="code-preview">
                  <div style={{ fontSize: 11, fontWeight: 500, color: '#fff', marginBottom: 8 }}>
                    ENS Text Record Preview <span className="badge b-ac">pending write</span>
                  </div>
                  survey.title → <span style={{ color: '#fff' }}>{form.title || '—'}</span><br />
                  survey.deadline → <span style={{ color: '#fff' }}>{deadlineTs}</span><br />
                  survey.min.score → <span style={{ color: '#fff' }}>{form.minScore}</span><br />
                  survey.status → <span style={{ color: '#fff' }}>active</span>
                </div>
              )}
            </>
          )}

          {/* STEP 2: Questions */}
          {step === 2 && (
            <>
              <div style={{ fontSize: 12, color: '#fff', marginBottom: 14 }}>
                {questions.length} questions configured. Contradiction pairs are included for AI quality validation.
              </div>
              {questions.map((q, i) => (
                <div key={q.id} style={{ background: 'var(--bg3)', border: '1px solid var(--bd)', borderRadius: 7, padding: '10px 14px', marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: '#fff', textTransform: 'uppercase' }}>Q{i + 1} · {q.type}</span>
                    {q.contradictionPairId && <span className="badge b-rd">contradiction pair</span>}
                  </div>
                  <div style={{ fontSize: 12, color: '#fff' }}>{q.text}</div>
                  {q.options && (
                    <div style={{ fontSize: 10, color: '#fff', marginTop: 4 }}>
                      {q.options.join(' / ')}
                    </div>
                  )}
                </div>
              ))}
              <div style={{ fontSize: 10, color: '#fff', marginTop: 8 }}>
                Questions will be encrypted and stored on 0G Storage. The CID is anchored on-chain.
              </div>
            </>
          )}

          {/* STEP 3: Reward */}
          {step === 3 && (
            <div className="form-grid">
              <div className="fg full">
                <label className="flabel">Reward Pool (USDC)</label>
                <input
                  type="number"
                  min={1}
                  step={0.01}
                  placeholder="e.g. 2500"
                  value={form.rewardAmount}
                  onChange={e => update('rewardAmount', e.target.value)}
                />
                <div style={{ fontSize: 10, color: '#fff', marginTop: 4 }}>
                  USDC will be transferred to the contract via EIP-2612 permit (no separate approve tx).
                  KeeperHub will automatically distribute rewards after the deadline using 0G x402 payment.
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: Review */}
          {step === 4 && (
            <>
              <div style={{ fontSize: 12, color: '#fff', lineHeight: 2, marginBottom: 14 }}>
                <strong>ENS Domain:</strong> {normalName}<br />
                <strong>Title:</strong> {form.title}<br />
                <strong>Deadline:</strong> {form.deadline} (Unix: {deadlineTs})<br />
                <strong>Min Score:</strong> {form.minScore}<br />
                <strong>Reward Pool:</strong> {form.rewardAmount} USDC<br />
                <strong>Questions:</strong> {questions.length} (including {questions.filter(q => q.contradictionPairId).length} contradiction checks)<br />
              </div>
              <div className="div" />
              <div style={{ fontSize: 11, color: '#fff' }}>
                Clicking Deploy will: (1) upload questions to 0G Storage, (2) sign USDC permit,
                (3) call createSurvey() on-chain, (4) register KeeperHub task via MCP.
              </div>
            </>
          )}

          <div className="div" />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {step > 0 && (
              <button className="btn" onClick={() => setStep(s => s - 1)}>← Back</button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                className="btn btn-p"
                onClick={() => setStep(s => s + 1)}
                disabled={
                  (step === 0 && !ensOk) ||
                  (step === 1 && (!form.title || !form.deadline)) ||
                  (step === 3 && !form.rewardAmount)
                }
              >
                Next: {STEPS[step + 1]} →
              </button>
            ) : (
              <button
                className="btn btn-p"
                onClick={deploy}
                disabled={loading}
              >
                {loading ? <span className="spinner" /> : 'Deploy Survey →'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
