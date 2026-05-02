import { ethers } from 'ethers';
import type { SubmitAnswerPayload } from '@agent/types';

export const SURVEY_REWARD_ABI = [
  'function createSurvey(bytes32 ensNode, uint256 deadline, uint8 minQualityScore, uint256 rewardAmount, string calldata questionCID, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) external',
  'function submitAnswer(bytes32 ensNode, string calldata answerCID, uint8 qualityScore, bytes calldata attestation) external',
  'function distributeRewards(bytes32 ensNode) external',
  'function withdraw() external',
  'function getRespondents(bytes32 ensNode) external view returns (address[])',
  'function surveyExists(bytes32 ensNode) external view returns (bool)',
  'function hasAnswered(bytes32 ensNode, address respondent) external view returns (bool)',
  'function survey(bytes32) external view returns (address creator, uint96 rewardPool, uint256 deadline, uint32 respondentCount, uint8 minQualityScore, bool distributed, string questionCID)',
  'function answers(bytes32, address) external view returns (uint8 qualityScore, bool submitted, string cid)',
  'function claimableBalance(address) external view returns (uint256)',
  'event SurveyCreated(bytes32 indexed ensNode, address indexed creator, uint256 deadline, uint256 rewardPool)',
  'event AnswerSubmitted(bytes32 indexed ensNode, address indexed respondent, uint8 qualityScore, string cid)',
  'event RewardsDistributed(bytes32 indexed ensNode, uint256 totalDistributed, uint256 validRespondents)',
  'event RewardClaimed(address indexed respondent, uint256 amount)',
];

export interface SurveyInfo {
  creator:        string;
  rewardPool:     bigint;
  deadline:       bigint;
  respondentCount:number;
  minQualityScore:number;
  distributed:    boolean;
  questionCID:    string;
}

export interface AnswerRecord {
  qualityScore: number;
  submitted:    boolean;
  cid:          string;
}

export function getSurveyRewardContract(
  address: string,
  signerOrProvider: ethers.Signer | ethers.Provider,
): ethers.Contract {
  return new ethers.Contract(address, SURVEY_REWARD_ABI, signerOrProvider);
}

export async function fetchSurvey(
  contractAddress: string,
  ensNodeHex: string,
  provider: ethers.Provider,
): Promise<SurveyInfo | null> {
  const c = getSurveyRewardContract(contractAddress, provider);
  try {
    const [creator, rewardPool, deadline, respondentCount, minQualityScore, distributed, questionCID] =
      await c.survey(ensNodeHex) as [string, bigint, bigint, bigint, bigint, boolean, string];
    if (creator === ethers.ZeroAddress) return null;
    return {
      creator,
      rewardPool,
      deadline,
      respondentCount: Number(respondentCount),
      minQualityScore: Number(minQualityScore),
      distributed,
      questionCID,
    };
  } catch {
    return null;
  }
}

export async function fetchClaimableBalance(
  contractAddress: string,
  walletAddress: string,
  provider: ethers.Provider,
): Promise<bigint> {
  const c = getSurveyRewardContract(contractAddress, provider);
  return c.claimableBalance(walletAddress) as Promise<bigint>;
}

export async function fetchHasAnswered(
  contractAddress: string,
  ensNodeHex: string,
  respondent: string,
  provider: ethers.Provider,
): Promise<boolean> {
  const c = getSurveyRewardContract(contractAddress, provider);
  return c.hasAnswered(ensNodeHex, respondent) as Promise<boolean>;
}

export async function txCreateSurvey(
  contractAddress: string,
  signer: ethers.Signer,
  ensNodeHex: string,
  deadline: bigint,
  minQualityScore: number,
  rewardAmount: bigint,
  questionCID: string,
  permitDeadline: bigint,
  v: number,
  r: string,
  s: string,
): Promise<ethers.TransactionReceipt> {
  const c = getSurveyRewardContract(contractAddress, signer);
  const tx = await c.createSurvey(
    ensNodeHex, deadline, minQualityScore, rewardAmount,
    questionCID, permitDeadline, v, r, s,
  ) as ethers.TransactionResponse;
  return tx.wait() as Promise<ethers.TransactionReceipt>;
}

export async function txSubmitAnswer(
  contractAddress: string,
  signer: ethers.Signer,
  payload: SubmitAnswerPayload,
): Promise<ethers.TransactionReceipt> {
  const c = getSurveyRewardContract(contractAddress, signer);
  const tx = await c.submitAnswer(
    payload.ensNode,
    payload.answerCID,
    payload.qualityScore,
    payload.attestation,
  ) as ethers.TransactionResponse;
  return tx.wait() as Promise<ethers.TransactionReceipt>;
}

export async function txWithdraw(
  contractAddress: string,
  signer: ethers.Signer,
): Promise<ethers.TransactionReceipt> {
  const c = getSurveyRewardContract(contractAddress, signer);
  const tx = await c.withdraw() as ethers.TransactionResponse;
  return tx.wait() as Promise<ethers.TransactionReceipt>;
}
