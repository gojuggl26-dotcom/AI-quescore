/**
 * Tests for KeeperRegistrationAgent.
 *
 * ethers (JsonRpcProvider, Wallet, Interface, ensNormalize, namehash) and
 * MCPKeeperClient are mocked so tests run without network access.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetResolver = jest.fn();
const mockEncodeFunctionData = jest.fn().mockReturnValue('0xdeadbeef');

jest.mock('ethers', () => ({
  JsonRpcProvider: jest.fn().mockImplementation(() => ({
    getResolver: mockGetResolver,
  })),
  Wallet: jest.fn().mockReturnValue({}),
  Interface: jest.fn().mockImplementation(() => ({
    encodeFunctionData: mockEncodeFunctionData,
  })),
  ensNormalize: jest.fn((name: string) => name.toLowerCase()),
  namehash: jest.fn().mockReturnValue(('0x' + '00'.repeat(32)) as `0x${string}`),
}));

const mockConnect    = jest.fn().mockResolvedValue(undefined);
const mockRegisterTask = jest.fn();
const mockClose      = jest.fn().mockResolvedValue(undefined);

jest.mock('../agent/MCPKeeperclient', () => ({
  MCPKeeperClient: jest.fn().mockImplementation(() => ({
    connect:      mockConnect,
    registerTask: mockRegisterTask,
    close:        mockClose,
  })),
}));

import {
  KeeperRegistrationAgent,
  KeeperInputValidationError,
  ENSResolutionError,
  DeadlineError,
} from '../agent/KeeperRegistrationAgent';
import type { KeeperAgentConfig, KeeperRegistrationInput } from '../agent/KeeperTypes';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CONFIG: KeeperAgentConfig = {
  mcpEndpoint:    'https://keeperhub.example.com/mcp',
  evmRpcUrl:      'https://rpc.example.com',
  privateKey:     ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  usdcAddress:    ('0x' + 'cd'.repeat(20)) as `0x${string}`,
  paymentChainId: 1,
};

const VALID_INPUT: KeeperRegistrationInput = {
  ensName:         'mysurvey.eth',
  contractAddress: ('0x' + 'ef'.repeat(20)) as `0x${string}`,
  chainId:         11155111,
};

// Future deadline: 1 hour from an arbitrary base
const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 3600;

function makeAgent(overrides: Partial<KeeperAgentConfig> = {}): KeeperRegistrationAgent {
  return new KeeperRegistrationAgent({ ...BASE_CONFIG, ...overrides });
}

// ─── Constructor / config validation ─────────────────────────────────────────

describe('KeeperRegistrationAgent — constructor', () => {
  it('constructs with valid config', () => {
    expect(() => makeAgent()).not.toThrow();
  });

  it('throws when mcpEndpoint is empty', () => {
    expect(() => makeAgent({ mcpEndpoint: '' })).toThrow('config.mcpEndpoint is required');
  });

  it('throws when mcpEndpoint is not a valid URL', () => {
    expect(() => makeAgent({ mcpEndpoint: 'not-a-url' })).toThrow(
      'config.mcpEndpoint is not a valid URL',
    );
  });

  it('throws when evmRpcUrl is empty', () => {
    expect(() => makeAgent({ evmRpcUrl: '' })).toThrow('config.evmRpcUrl is required');
  });

  it('throws when privateKey is empty', () => {
    expect(() => makeAgent({ privateKey: '' as `0x${string}` })).toThrow(
      'config.privateKey is required',
    );
  });

  it('throws when usdcAddress is empty', () => {
    expect(() => makeAgent({ usdcAddress: '' as `0x${string}` })).toThrow(
      'config.usdcAddress is required',
    );
  });

  it('throws when paymentChainId is 0', () => {
    expect(() => makeAgent({ paymentChainId: 0 })).toThrow(
      'config.paymentChainId must be a positive integer',
    );
  });

  it('throws when paymentChainId is negative', () => {
    expect(() => makeAgent({ paymentChainId: -1 })).toThrow(
      'config.paymentChainId must be a positive integer',
    );
  });

  it('throws when paymentChainId is not an integer', () => {
    expect(() => makeAgent({ paymentChainId: 1.5 })).toThrow(
      'config.paymentChainId must be a positive integer',
    );
  });
});

// ─── getCapabilities ──────────────────────────────────────────────────────────

describe('KeeperRegistrationAgent — getCapabilities', () => {
  it('returns a non-empty string array', () => {
    const caps = makeAgent().getCapabilities();
    expect(Array.isArray(caps)).toBe(true);
    expect(caps.length).toBeGreaterThan(0);
  });

  it('includes key capability identifiers', () => {
    const caps = makeAgent().getCapabilities();
    expect(caps).toContain('keeperhub-mcp-registration');
    expect(caps).toContain('x402-autonomous-payment');
    expect(caps).toContain('openclaw-compatible');
  });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe('KeeperRegistrationAgent — validateInput (via execute)', () => {
  beforeEach(() => {
    // Default: resolver returns a far-future deadline
    mockGetResolver.mockResolvedValue({
      getText: jest.fn().mockResolvedValue(String(FUTURE_DEADLINE)),
    });
    mockRegisterTask.mockResolvedValue({
      taskId:           'task-001',
      scheduledFor:     FUTURE_DEADLINE - 30,
      confirmedAt:      Math.floor(Date.now() / 1000),
      estimatedGasLimit: 600000,
    });
  });

  it('throws KeeperInputValidationError for null input', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute(null as unknown as KeeperRegistrationInput),
    ).rejects.toThrow(KeeperInputValidationError);
  });

  it('throws for empty ensName', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ ...VALID_INPUT, ensName: '' }),
    ).rejects.toThrow(KeeperInputValidationError);
  });

  it('throws for ensName without a dot', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ ...VALID_INPUT, ensName: 'nodot' }),
    ).rejects.toThrow(KeeperInputValidationError);
  });

  it('throws for contractAddress without 0x prefix', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        ...VALID_INPUT,
        contractAddress: ('ef'.repeat(20)) as `0x${string}`,
      }),
    ).rejects.toThrow(KeeperInputValidationError);
  });

  it('throws for contractAddress with wrong length (< 42 chars)', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ ...VALID_INPUT, contractAddress: '0xshort' as `0x${string}` }),
    ).rejects.toThrow(KeeperInputValidationError);
  });

  it('throws for chainId = 0', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ ...VALID_INPUT, chainId: 0 }),
    ).rejects.toThrow(KeeperInputValidationError);
  });

  it('throws for non-integer chainId', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ ...VALID_INPUT, chainId: 1.5 }),
    ).rejects.toThrow(KeeperInputValidationError);
  });
});

// ─── ENS resolution errors ────────────────────────────────────────────────────

describe('KeeperRegistrationAgent — ENS resolution (via execute)', () => {
  it('throws ENSResolutionError when getResolver rejects', async () => {
    mockGetResolver.mockRejectedValueOnce(new Error('network error'));
    const agent = makeAgent();
    await expect(agent.execute(VALID_INPUT)).rejects.toThrow(ENSResolutionError);
  });

  it('throws ENSResolutionError when resolver is null (domain not registered)', async () => {
    mockGetResolver.mockResolvedValueOnce(null);
    const agent = makeAgent();
    await expect(agent.execute(VALID_INPUT)).rejects.toThrow(ENSResolutionError);
  });

  it('throws ENSResolutionError when getText rejects', async () => {
    mockGetResolver.mockResolvedValueOnce({
      getText: jest.fn().mockRejectedValue(new Error('getText failed')),
    });
    const agent = makeAgent();
    await expect(agent.execute(VALID_INPUT)).rejects.toThrow(ENSResolutionError);
  });

  it('throws ENSResolutionError when survey.deadline text record is empty', async () => {
    mockGetResolver.mockResolvedValueOnce({
      getText: jest.fn().mockResolvedValue(''),
    });
    const agent = makeAgent();
    await expect(agent.execute(VALID_INPUT)).rejects.toThrow(ENSResolutionError);
  });

  it('throws ENSResolutionError when survey.deadline is null', async () => {
    mockGetResolver.mockResolvedValueOnce({
      getText: jest.fn().mockResolvedValue(null),
    });
    const agent = makeAgent();
    await expect(agent.execute(VALID_INPUT)).rejects.toThrow(ENSResolutionError);
  });

  it('throws ENSResolutionError when survey.deadline is not a valid integer', async () => {
    mockGetResolver.mockResolvedValueOnce({
      getText: jest.fn().mockResolvedValue('not-a-number'),
    });
    const agent = makeAgent();
    await expect(agent.execute(VALID_INPUT)).rejects.toThrow(ENSResolutionError);
  });
});

// ─── Deadline errors ──────────────────────────────────────────────────────────

describe('KeeperRegistrationAgent — DeadlineError (via execute)', () => {
  it('throws DeadlineError when deadline is in the past', async () => {
    const pastDeadline = Math.floor(Date.now() / 1000) - 1000;
    mockGetResolver.mockResolvedValueOnce({
      getText: jest.fn().mockResolvedValue(String(pastDeadline)),
    });
    const agent = makeAgent();
    await expect(agent.execute(VALID_INPUT)).rejects.toThrow(DeadlineError);
  });

  it('throws DeadlineError when deadline is within 5 minutes (MIN_DEADLINE_MARGIN)', async () => {
    const tooSoon = Math.floor(Date.now() / 1000) + 60; // only 60 s away
    mockGetResolver.mockResolvedValueOnce({
      getText: jest.fn().mockResolvedValue(String(tooSoon)),
    });
    const agent = makeAgent();
    await expect(agent.execute(VALID_INPUT)).rejects.toThrow(DeadlineError);
  });
});

// ─── execute — happy path ─────────────────────────────────────────────────────

describe('KeeperRegistrationAgent — execute happy path', () => {
  beforeEach(() => {
    mockGetResolver.mockResolvedValue({
      getText: jest.fn().mockResolvedValue(String(FUTURE_DEADLINE)),
    });
    mockRegisterTask.mockResolvedValue({
      taskId:            'task-happy',
      scheduledFor:      FUTURE_DEADLINE - 30,
      confirmedAt:       Math.floor(Date.now() / 1000),
      estimatedGasLimit: 600000,
    });
  });

  it('returns KeeperRegistrationOutput with expected fields', async () => {
    const agent  = makeAgent();
    const output = await agent.execute(VALID_INPUT);

    expect(output.taskId).toBe('task-happy');
    expect(output.ensName).toBe(VALID_INPUT.ensName);
    expect(typeof output.normalizedName).toBe('string');
    expect(typeof output.ensNode).toBe('string');
    expect(output.triggerTimestamp).toBe(FUTURE_DEADLINE);
    expect(typeof output.scheduledAt).toBe('number');
  });

  it('always calls mcpClient.close() even when registerTask rejects', async () => {
    mockRegisterTask.mockRejectedValueOnce(new Error('KeeperHub down'));
    const agent = makeAgent();
    await expect(agent.execute(VALID_INPUT)).rejects.toThrow('KeeperHub down');
    expect(mockClose).toHaveBeenCalled();
  });

  it('calls encodeDistributeRewards via Interface.encodeFunctionData', async () => {
    const agent = makeAgent();
    await agent.execute(VALID_INPUT);
    expect(mockEncodeFunctionData).toHaveBeenCalledWith('distributeRewards', [
      expect.any(String),
    ]);
  });
});

// ─── Error class shapes ───────────────────────────────────────────────────────

describe('Error classes', () => {
  it('KeeperInputValidationError has correct name', () => {
    const e = new KeeperInputValidationError('msg');
    expect(e.name).toBe('KeeperInputValidationError');
    expect(e.message).toBe('msg');
    expect(e).toBeInstanceOf(Error);
  });

  it('ENSResolutionError carries cause', () => {
    const cause = new Error('root cause');
    const e = new ENSResolutionError('wrapper', cause);
    expect(e.name).toBe('ENSResolutionError');
    expect(e.cause).toBe(cause);
  });

  it('DeadlineError has correct name', () => {
    const e = new DeadlineError('too close');
    expect(e.name).toBe('DeadlineError');
    expect(e).toBeInstanceOf(Error);
  });
});
