// OpenAI mock must be declared before importing preferenceLearningService
jest.mock('openai', () => {
  const mockCreate = jest.fn();
  const MockConstructor = jest.fn().mockReturnValue({
    chat: { completions: { create: mockCreate } },
  });
  (MockConstructor as any).__mockCreate = mockCreate;
  return { __esModule: true, default: MockConstructor };
});

import OpenAI from 'openai';
import mongoose from 'mongoose';
import User from '../models/User';
import { analyzeRejectionAndUpdatePreferences } from '../services/preferenceLearningService';

const MockOpenAI = OpenAI as unknown as jest.Mock;
let mockCreate: jest.Mock;

beforeEach(() => {
  mockCreate = (MockOpenAI as any).__mockCreate as jest.Mock;
  mockCreate.mockClear();
});

function openAIResponse(updatedInsights: string) {
  return {
    choices: [{ message: { content: JSON.stringify({ updatedInsights }) } }],
  };
}

async function createUser(learnedPreferences?: { insights: string; lastUpdated: Date; feedbackCount: number }) {
  return User.create({
    name: 'Test User',
    email: `test-${Date.now()}-${Math.random()}@example.com`,
    password: 'hashed',
    resume: { skills: ['React'], experience: [], education: [], summary: 'Dev' },
    preferences: {
      jobTypes: [],
      location: [],
      remoteOnly: false,
      minSalary: 0,
      industries: [],
      minScore: 30,
      matchingEnabled: true,
    },
    ...(learnedPreferences ? { learnedPreferences } : {}),
  });
}

function fakeJob() {
  return {
    title: 'Software Engineer',
    company: 'Acme',
    location: ['Remote'],
    salary: '100k',
    tags: [],
    description: 'Build great software',
  } as any;
}

function fakeMatch() {
  return {
    matchScore: 75,
    verdict: 'Good match',
    reasoning: 'Strong skills',
  } as any;
}

// ---------------------------------------------------------------------------
// analyzeRejectionAndUpdatePreferences
// ---------------------------------------------------------------------------

describe('analyzeRejectionAndUpdatePreferences', () => {
  it('updates learnedPreferences in DB when OpenAI returns valid response', async () => {
    const user = await createUser();
    mockCreate.mockResolvedValue(openAIResponse('Prefers fully remote roles. Avoids early-stage startups.'));

    const result = await analyzeRejectionAndUpdatePreferences(
      user as any,
      fakeJob(),
      fakeMatch(),
      { category: 'location', details: 'Too many office days' },
    );

    expect(result).not.toBeNull();
    expect(result!.insights).toBe('Prefers fully remote roles. Avoids early-stage startups.');
    expect(result!.feedbackCount).toBe(1);

    const updated = await User.findById(user._id);
    expect(updated!.learnedPreferences).toBeDefined();
    expect(updated!.learnedPreferences!.insights).toBe('Prefers fully remote roles. Avoids early-stage startups.');
    expect(updated!.learnedPreferences!.feedbackCount).toBe(1);
    expect(updated!.learnedPreferences!.lastUpdated).toBeDefined();
  });

  it('increments feedbackCount from existing value', async () => {
    const user = await createUser({
      insights: 'Prefers remote.',
      lastUpdated: new Date(),
      feedbackCount: 3,
    });
    mockCreate.mockResolvedValue(openAIResponse('Prefers remote. Avoids travel-heavy roles.'));

    const result = await analyzeRejectionAndUpdatePreferences(
      user as any,
      fakeJob(),
      fakeMatch(),
      { category: 'location', details: 'Too much travel' },
    );

    expect(result!.feedbackCount).toBe(4);

    const updated = await User.findById(user._id);
    expect(updated!.learnedPreferences!.feedbackCount).toBe(4);
  });

  it('returns null and skips OpenAI call for job_inactive category', async () => {
    const user = await createUser();

    const result = await analyzeRejectionAndUpdatePreferences(
      user as any,
      fakeJob(),
      fakeMatch(),
      { category: 'job_inactive' },
    );

    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();

    const updated = await User.findById(user._id);
    expect(updated!.learnedPreferences).toBeUndefined();
  });

  it('returns null and leaves preferences unchanged when OpenAI response has no JSON', async () => {
    const user = await createUser();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Plain text with no JSON object here' } }],
    });

    const result = await analyzeRejectionAndUpdatePreferences(
      user as any,
      fakeJob(),
      fakeMatch(),
      { category: 'salary', details: 'Compensation too low' },
    );

    expect(result).toBeNull();

    const updated = await User.findById(user._id);
    expect(updated!.learnedPreferences).toBeUndefined();
  });

  it('returns null and leaves preferences unchanged when OpenAI returns empty content', async () => {
    const user = await createUser();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: null } }],
    });

    const result = await analyzeRejectionAndUpdatePreferences(
      user as any,
      fakeJob(),
      fakeMatch(),
      { category: 'salary' },
    );

    expect(result).toBeNull();

    const updated = await User.findById(user._id);
    expect(updated!.learnedPreferences).toBeUndefined();
  });

  it('returns null without throwing when OpenAI call throws', async () => {
    const user = await createUser();
    mockCreate.mockRejectedValue(new Error('OpenAI API unavailable'));

    const result = await analyzeRejectionAndUpdatePreferences(
      user as any,
      fakeJob(),
      fakeMatch(),
      { category: 'salary', details: 'Too low' },
    );

    expect(result).toBeNull();

    // No exception should have propagated — preferences stay unchanged
    const updated = await User.findById(user._id);
    expect(updated!.learnedPreferences).toBeUndefined();
  });
});
