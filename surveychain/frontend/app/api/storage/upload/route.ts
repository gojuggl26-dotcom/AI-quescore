import { NextRequest, NextResponse } from 'next/server';
import type { AnswerData } from '@agent/types';
import { AgentStorage } from '@agent/memory/storage';

export async function POST(req: NextRequest) {
  let body: { answerData: AnswerData; respondent: string };
  try {
    body = await req.json() as { answerData: AnswerData; respondent: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const required = ['ZG_STORAGE_URL', 'ZG_FLOW_ADDRESS', 'NEXT_PUBLIC_RPC_URL', 'AGENT_PRIVATE_KEY'];
  for (const key of required) {
    if (!process.env[key]) {
      return NextResponse.json({ error: `Missing env var: ${key}` }, { status: 500 });
    }
  }

  try {
    const storage = new AgentStorage(
      process.env.ZG_STORAGE_URL!,
      process.env.ZG_FLOW_ADDRESS!,
      process.env.AGENT_PRIVATE_KEY! as `0x${string}`,
      process.env.NEXT_PUBLIC_RPC_URL!,
    );

    const plaintext = Buffer.from(JSON.stringify(body.answerData), 'utf8');
    const filename  = `answers_${body.respondent}_${Date.now()}.json.enc`;
    const cid       = await storage.uploadRaw(plaintext, filename);
    return NextResponse.json({ cid });
  } catch (err) {
    console.error('[/api/storage/upload]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
