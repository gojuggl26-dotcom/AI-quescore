import { NextRequest, NextResponse } from 'next/server';
import { AgentStorage } from '@agent/memory/storage';
import type { QuestionItem } from '@/lib/storage';

export async function GET(req: NextRequest) {
  const cid = req.nextUrl.searchParams.get('cid');
  if (!cid) return NextResponse.json({ error: 'Missing cid' }, { status: 400 });

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

    const pattern = await storage.loadPattern(cid).catch(() => null);
    if (!pattern) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const questions = JSON.parse(JSON.stringify(pattern)) as QuestionItem[];
    return NextResponse.json(questions);
  } catch (err) {
    console.error('[/api/storage/questions]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
