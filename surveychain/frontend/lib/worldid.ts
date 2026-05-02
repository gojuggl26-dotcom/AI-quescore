export interface WorldIdProof {
  merkle_root: string;
  nullifier_hash: string;
  proof: string;
  verification_level: 'orb' | 'device';
}

export async function verifyWorldId(
  signal: string,
  actionId: string,
  proof: WorldIdProof,
): Promise<boolean> {
  const res = await fetch('/api/worldid/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signal, actionId, proof }),
  });
  if (!res.ok) return false;
  const data = await res.json() as { verified: boolean };
  return data.verified;
}
