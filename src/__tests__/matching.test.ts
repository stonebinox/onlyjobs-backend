// OpenAI mock must be declared before importing matchingService (module-level singleton compatible)
jest.mock('openai', () => {
  const mockCreate = jest.fn();
  const MockConstructor = jest.fn().mockReturnValue({
    chat: { completions: { create: mockCreate } },
  });
  (MockConstructor as any).__mockCreate = mockCreate;
  return { __esModule: true, default: MockConstructor };
});

jest.mock('../services/userService', () => ({
  getUserQnA: jest.fn().mockResolvedValue([]),
}));

import OpenAI from 'openai';
import mongoose from 'mongoose';
import MatchRecord, { Freshness } from '../models/MatchRecord';
import JobListing from '../models/JobListing';
import {
  calculateJobFreshness,
  getMatchesData,
  skipMatch,
  markMatchAppliedStatus,
  matchUserToJob,
} from '../services/matchingService';

const MockOpenAI = OpenAI as unknown as jest.Mock;

// ---------------------------------------------------------------------------
// calculateJobFreshness
// ---------------------------------------------------------------------------

describe('calculateJobFreshness', () => {
  it('returns FRESH for job scraped yesterday', () => {
    const job = { scrapedDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) } as any;
    expect(calculateJobFreshness(job)).toBe(Freshness.FRESH);
  });

  it('returns WARM for job scraped 10 days ago', () => {
    const job = { scrapedDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } as any;
    expect(calculateJobFreshness(job)).toBe(Freshness.WARM);
  });

  it('returns STALE for job scraped 30 days ago', () => {
    const job = { scrapedDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } as any;
    expect(calculateJobFreshness(job)).toBe(Freshness.STALE);
  });
});

// ---------------------------------------------------------------------------
// getMatchesData
// ---------------------------------------------------------------------------

describe('getMatchesData', () => {
  it('returns populated matches for existing jobs', async () => {
    const userId = new mongoose.Types.ObjectId();

    const job1 = await JobListing.create({
      title: 'Frontend Engineer',
      company: 'Acme',
      location: ['Remote'],
      source: 'test',
      description: 'Build UIs',
      url: 'https://example.com/job1',
      scrapedDate: new Date(),
    });
    const job2 = await JobListing.create({
      title: 'Backend Engineer',
      company: 'Globex',
      location: ['Remote'],
      source: 'test',
      description: 'Build APIs',
      url: 'https://example.com/job2',
      scrapedDate: new Date(),
    });

    await MatchRecord.create({
      userId,
      jobId: job1._id,
      matchScore: 85,
      verdict: 'Good match',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: null,
    });
    await MatchRecord.create({
      userId,
      jobId: job2._id,
      matchScore: 70,
      verdict: 'Decent match',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: null,
    });

    const results = await getMatchesData(userId.toString());
    expect(results).toHaveLength(2);
    const titles = results.map((r: any) => r.job.title);
    expect(titles).toContain('Frontend Engineer');
    expect(titles).toContain('Backend Engineer');
    const scores = results.map((r: any) => r.matchScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('filters out matches for deleted/missing jobs', async () => {
    const userId = new mongoose.Types.ObjectId();

    await MatchRecord.create({
      userId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 80,
      verdict: 'Good match',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: null,
    });

    const results = await getMatchesData(userId.toString());
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// skipMatch
// ---------------------------------------------------------------------------

describe('skipMatch', () => {
  it('sets skipped=true on match', async () => {
    const userId = new mongoose.Types.ObjectId();
    const match = await MatchRecord.create({
      userId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 80,
      verdict: 'Good match',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: null,
    });

    await skipMatch((match._id as mongoose.Types.ObjectId).toString(), userId.toString());

    const updated = await MatchRecord.findById(match._id);
    expect(updated!.skipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// markMatchAppliedStatus
// ---------------------------------------------------------------------------

describe('markMatchAppliedStatus', () => {
  it('sets applied=true on match', async () => {
    const userId = new mongoose.Types.ObjectId();
    const match = await MatchRecord.create({
      userId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 80,
      verdict: 'Good match',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: null,
    });

    await markMatchAppliedStatus(
      (match._id as mongoose.Types.ObjectId).toString(),
      userId.toString(),
      true,
    );

    const updated = await MatchRecord.findById(match._id);
    expect(updated!.applied).toBe(true);
    expect(updated!.appliedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// matchUserToJob
// ---------------------------------------------------------------------------

describe('matchUserToJob', () => {
  beforeEach(() => {
    (MockOpenAI as any).__mockCreate.mockResolvedValue({
      choices: [{
        message: {
          content: '{"matchScore": 75, "verdict": "Good match", "reasoning": "Strong skills match"}',
        },
      }],
    });
  });

  it('returns a numeric match score between 0 and 100', async () => {
    const user = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Test User',
      resume: 'Software engineer with 5 years experience',
      preferences: {},
      learnedPreferences: null,
    } as any;

    const job = await JobListing.create({
      title: 'Software Engineer',
      company: 'Test Co',
      location: ['Remote'],
      source: 'test',
      description: 'A great job',
      url: 'https://example.com/job',
      scrapedDate: new Date(),
    });

    const result = await matchUserToJob(user, job);
    expect(result.matchScore).toBe(75);
  });
});
