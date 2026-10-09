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

  it('hydrates a Himalayas-source match with postedDate older than 15 days (display path is source-agnostic)', async () => {
    // Oracle (xkjp acceptance item D): retiring Himalayas must NOT hide EXISTING historical
    // Himalayas matches the user already holds. The corpus-scan exclusion only affects
    // the nightly-matcher corpus (scrape/match pipeline). The display path (getMatchesData /
    // GET /api/matches) is source-agnostic: it returns any MatchRecord whose jobId resolves
    // to a JobListing, regardless of source or postedDate.
    //
    // Wrong impl (corpus exclusion applied to display): returns [] → FAILS.
    // Wrong impl (postedDate age-gate on display): returns [] → FAILS (20-day-old job).
    const userId = new mongoose.Types.ObjectId();

    // Old Himalayas job — postedDate more than 15 days ago (outside the corpus window).
    // This simulates a historical match created before retirement.
    const oldHimalayasJob = await JobListing.create({
      title: 'Old Himalayas Engineer',
      company: 'HimCo Historical',
      location: ['Remote'],
      source: 'Himalayas',
      description: 'Build production software at scale',
      url: `https://himalayas.app/old-job-display-${Date.now()}`,
      postedDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago
      scrapedDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    });

    // MatchRecord the nightly matcher created before retirement — must stay visible.
    await MatchRecord.create({
      userId,
      jobId: oldHimalayasJob._id,
      matchScore: 72,
      verdict: 'Good match',
      reasoning: 'Strong skills overlap',
      freshness: Freshness.STALE,
      clicked: false,
      skipped: false,
      applied: null,
    });

    const results = await getMatchesData(userId.toString());

    // The Himalayas-linked match IS returned — display path does not filter by source or age.
    expect(results).toHaveLength(1);
    expect(results[0].matchScore).toBe(72);
    // job must be hydrated (not null) — the display path must populate the JobListing.
    expect(results[0].job).not.toBeNull();
    expect((results[0].job as any).source).toBe('Himalayas');
    expect((results[0].job as any).title).toBe('Old Himalayas Engineer');
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

  it('returns the exact matchScore, verdict, and reasoning from the mocked matcher response', async () => {
    const expectedReasoning =
      'Your Node and MongoDB work maps almost exactly onto their stack, and they are explicit that the backend hire owns schema design. Worth applying.';

    (MockOpenAI as any).__mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            matchScore: 88,
            verdict: 'Strong match',
            reasoning: expectedReasoning,
          }),
        },
      }],
    });

    const user = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Test User',
      resume: 'Backend engineer with Node and MongoDB experience',
      preferences: {},
      learnedPreferences: null,
    } as any;

    const job = await JobListing.create({
      title: 'Backend Engineer',
      company: 'Test Co',
      location: ['Remote'],
      source: 'test',
      description: 'Own schema design for our backend',
      url: 'https://example.com/job-verdict',
      scrapedDate: new Date(),
    });

    const result = await matchUserToJob(user, job);

    expect(result.matchScore).toBe(88);
    expect(result.verdict).toBe('Strong match');
    expect(result.reasoning).toBe(expectedReasoning);
  });
});
