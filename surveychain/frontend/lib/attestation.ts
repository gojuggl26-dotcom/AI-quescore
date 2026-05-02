import { ethers } from 'ethers';
import type { SubmitAnswerPayload } from '@agent/types';

export function verifyAttestationLocally(
  payload: SubmitAnswerPayload,
  expectedSigner: string,
): boolean {
  try {
    const innerHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'address', 'uint8', 'string'],
      [payload.ensNode, payload.ensNode, payload.qualityScore, payload.answerCID],
    );
    const msgHash = ethers.hashMessage(ethers.getBytes(innerHash));
    const recovered = ethers.recoverAddress(msgHash, payload.attestation);
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

export function attestationSignerAddress(
  payload: SubmitAnswerPayload,
): string | null {
  try {
    const innerHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'address', 'uint8', 'string'],
      [payload.ensNode, payload.ensNode, payload.qualityScore, payload.answerCID],
    );
    const msgHash = ethers.hashMessage(ethers.getBytes(innerHash));
    return ethers.recoverAddress(msgHash, payload.attestation);
  } catch {
    return null;
  }
}
