import { NextRequest, NextResponse } from 'next/server';
import type { AnswerData, AgentConfig } from '../../../agent/types';

function getAgentConfig(): AgentConfig {
  const required = [
    'ZG_STORAGE_URL', 'ZG_FLOW_ADDRESS', 'ZG_COMPUTE_URL',
    'NEXT_PUBLIC_RPC_URL', 'AGENT_PRIVATE_KEY', 'AGENT_MODEL_NAME',
    'AGENT_MODEL_HASH', 'AGENT_NODE_PUBLIC_KEY',
  ] as const;
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing env var: ${key}`);
    }
  }
  return {
    zgStorageUrl:       process.env.ZG_STORAGE_URL!,
    zgFlowAddress:      process.env.ZG_FLOW_ADDRESS!,
    zgComputeUrl:       process.env.ZG_COMPUTE_URL!,
    evmRpcUrl:          process.env.NEXT_PUBLIC_RPC_URL!,
    privateKey:         process.env.AGENT_PRIVATE_KEY! as `0x${string}`,
    modelName:          process.env.AGENT_MODEL_NAME!,
    fallbackModelName:  process.env.AGENT_FALLBACK_MODEL ?? process.env.AGENT_MODEL_NAME!,
    modelHash:          process.env.AGENT_MODEL_HASH!,
    nodePublicKey:      process.env.AGENT_NODE_PUBLIC_KEY!,
    indexCid:           process.env.AGENT_INDEX_CID ?? undefined,
  };
}

export async function POST(req: NextRequest) {
  let body: { answerData: AnswerData; respondent: string };
  try {
    body = await req.json() as { answerData: AnswerData; respondent: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { answerData } = body;
  if (!answerData) {
    return NextResponse.json({ error: 'Missing answerData' }, { status: 400 });
  }

  let config: AgentConfig;
  try {
    config = getAgentConfig();
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  try {
    const { QualityScoringAgent } = await import('../../../agent/QualityScoringAgent');
    const agent = new QualityScoringAgent(config);
    const result = await agent.execute({ answerData });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[/api/score]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
