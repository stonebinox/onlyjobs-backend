jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import JobListing from '../models/JobListing';
import MatchRecord from '../models/MatchRecord';
import matchRoutes from '../routes/matchRoutes';
import { applyPreferenceFilters } from '../utils/preferenceFilters';

function toStr(id: unknown): string {
  return (id as mongoose.Types.ObjectId).toString();
}

let testUserId: mongoose.Types.ObjectId;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.user = { _id: testUserId };
  next();
});
testApp.use('/api/matches', matchRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

let emailCounter = 0;

async function makeUser(overrides: Record<string, any> = {}) {
  emailCounter++;
  return User.create({
    _id: testUserId,
    name: 'Test',
    email: `test-${emailCounter}-${Date.now()}@example.com`,
    password: 'hashed',
    isVerified: true,
    resume: {
      summary: 'Engineer',
      skills: ['JS'],
      experience: [],
      education: [],
    },
    preferences: {
      // Production auto-disable always sets matchingEnabled: false alongside
      // matchingDisabledReason: 'auto_low_balance'. A fixture with true here
      // would never be written by the nightly job and masks BLOCKING 1.
      matchingEnabled: false,
      remoteOnly: false,
      minSalary: 0,
      location: [],
      jobTypes: [],
      industries: [],
      minScore: 30,
    },
    matchingDisabledReason: 'auto_low_balance',
    walletBalance: 0.10,
    skippedJobs: [],
    ...overrides,
  });
}

async function createJob(overrides: Record<string, any> = {}) {
  return JobListing.create({
    title: 'Engineer',
    company: 'Acme',
    location: ['Remote'],
    tags: ['remote'],
    source: 'tryremotework',
    description: 'desc',
    url: 'https://example.com/job',
    salary: { min: 0, max: 100000, currency: 'USD' },
    postedDate: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  testUserId = new mongoose.Types.ObjectId();
});

// ---------------------------------------------------------------------------
// 1. User not found in DB (mock bypasses auth so testUserId has no user)
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — no user in DB', () => {
  it('returns 404 when user does not exist', async () => {
    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 2. shouldShow: false for unverified user
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — unverified user', () => {
  it('returns shouldShow:false with reason unverified', async () => {
    await makeUser({ isVerified: false });
    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(false);
    expect(res.body.reason).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// 3. shouldShow: false for no-resume user
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — no resume', () => {
  it('returns shouldShow:false with reason no_resume when resume is missing', async () => {
    await makeUser({
      resume: { summary: '', skills: [], experience: [], education: [] },
    });
    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(false);
    expect(res.body.reason).toBe('no_resume');
  });
});

// ---------------------------------------------------------------------------
// 3b. shouldShow: false for whitespace-only resume
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — whitespace-only resume', () => {
  it('returns shouldShow:false with reason no_resume when resume is whitespace-only', async () => {
    await makeUser({
      resume: { summary: '   ', skills: ['  '], experience: [], education: [] },
    });
    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(false);
    expect(res.body.reason).toBe('no_resume');
  });
});

// ---------------------------------------------------------------------------
// 4. shouldShow: false when matchingEnabled is false
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — matchingEnabled false', () => {
  it('returns shouldShow:false with reason user_disabled', async () => {
    await makeUser({
      preferences: {
        matchingEnabled: false,
        remoteOnly: false,
        minSalary: 0,
        location: [],
        jobTypes: [],
        industries: [],
        minScore: 30,
      },
      matchingDisabledReason: 'user',
    });
    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(false);
    expect(res.body.reason).toBe('user_disabled');
  });
});

// ---------------------------------------------------------------------------
// 5. shouldShow: false when matchingDisabledReason is missing/undefined (legacy)
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — legacy user with no disabledReason', () => {
  it('returns shouldShow:false with reason user_disabled when matchingDisabledReason is undefined', async () => {
    // Use $unset to remove the field entirely from the created document
    await makeUser({ matchingDisabledReason: undefined });
    // Explicitly unset the field in mongo so it's truly absent (not null)
    await User.updateOne({ _id: testUserId }, { $unset: { matchingDisabledReason: 1 } });

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(false);
    expect(res.body.reason).toBe('user_disabled');
  });
});

// ---------------------------------------------------------------------------
// 6. shouldShow: false when walletBalance >= 0.30
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — sufficient balance', () => {
  it('returns shouldShow:false with reason sufficient_balance', async () => {
    await makeUser({ walletBalance: 0.30, matchingDisabledReason: 'auto_low_balance' });
    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(false);
    expect(res.body.reason).toBe('sufficient_balance');
  });

  it('returns shouldShow:false for balance > 0.30', async () => {
    await makeUser({ walletBalance: 1.50, matchingDisabledReason: 'auto_low_balance' });
    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(false);
    expect(res.body.reason).toBe('sufficient_balance');
  });
});

// ---------------------------------------------------------------------------
// 7a. shouldShow: true — matchingEnabled FALSE + reason auto_low_balance + balance < 0.30
//     (the real production auto-disable state)
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — auto_low_balance user (matchingEnabled:false)', () => {
  it('returns shouldShow:true when matchingEnabled is false but reason is auto_low_balance', async () => {
    await makeUser(); // matchingEnabled:false, reason:auto_low_balance, balance:0.10
    await createJob({ title: 'Eligible Job' });
    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);
    expect(res.body.reason).toBe('auto_low_balance');
    expect(res.body.walletBalance).toBe(0.10);
    expect(res.body.dailyMatchCost).toBe(0.3);
    expect(res.body.onDemandMatchCost).toBe(0.05);
    expect(res.body.count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7b. shouldShow: true — matchingEnabled TRUE + balance < 0.30
//     (pre-auto-disable state: user has low funds but nightly run hasn't fired yet)
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — low balance before auto-disable fires', () => {
  it('returns shouldShow:true when matchingEnabled is true and balance < 0.30', async () => {
    await makeUser({
      preferences: {
        matchingEnabled: true,
        remoteOnly: false,
        minSalary: 0,
        location: [],
        jobTypes: [],
        industries: [],
        minScore: 30,
      },
      matchingDisabledReason: undefined,
      walletBalance: 0.15,
    });
    await createJob({ title: 'Pre-disable Job' });
    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);
    expect(res.body.reason).toBe('auto_low_balance');
    expect(res.body.count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. COUNT PARITY TEST
//
// Parity goal: the endpoint count must equal what the low-balance email would
// compute for the same user and job pool. The email algorithm lives in
// onlyjobs-background/src/jobs/matchJobs.ts (cannot import directly — separate
// repo). It is: applyPreferenceFilters → exclude existing MatchRecords → exclude
// skippedJobs. We replicate it inline below; update this comment if that file
// changes.
//
// The pool covers all three preference filters plus both exclusion mechanisms
// so a regression in any one of them breaks this test. The HARDCODED expected
// count (2) is derived from the spec, not from calling the helper — that breaks
// the tautology of "assert helper(X) === helper(X)".
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — count parity with email logic', () => {
  it('endpoint count: salary, location, matchRecord, and skipped all reduce correctly', async () => {
    // User: auto-disabled, balance low, minSalary=60000, location=['London'], no remoteOnly filter.
    await makeUser({
      preferences: {
        matchingEnabled: false,
        remoteOnly: false,
        minSalary: 60000,
        location: ['London'],
        jobTypes: [],
        industries: [],
        minScore: 30,
      },
      matchingDisabledReason: 'auto_low_balance',
      walletBalance: 0.10,
    });

    // Job A — London, salary max 80k → ELIGIBLE
    await createJob({
      title: 'London Senior A',
      location: ['London'],
      salary: { min: 60000, max: 80000, currency: 'USD' },
    });
    // Job B — London, salary max 75k → ELIGIBLE
    await createJob({
      title: 'London Mid B',
      location: ['London'],
      salary: { min: 50000, max: 75000, currency: 'USD' },
    });
    // Job C — London, salary max 40k → SALARY SKIP (max 40k < minSalary 60k)
    await createJob({
      title: 'London Junior C',
      location: ['London'],
      salary: { min: 20000, max: 40000, currency: 'USD' },
    });
    // Job D — New York, salary max 80k → LOCATION SKIP (no London substring match)
    await createJob({
      title: 'NY Senior D',
      location: ['New York'],
      salary: { min: 60000, max: 80000, currency: 'USD' },
    });
    // Job E — London, salary max 90k → would be ELIGIBLE but has a MatchRecord
    const jobE = await createJob({
      title: 'London Match E',
      location: ['London'],
      salary: { min: 70000, max: 90000, currency: 'USD' },
    });
    // Job F — London, salary max 85k → would be ELIGIBLE but is in skippedJobs
    const jobF = await createJob({
      title: 'London Skipped F',
      location: ['London'],
      salary: { min: 65000, max: 85000, currency: 'USD' },
    });

    await MatchRecord.create({
      userId: testUserId,
      jobId: jobE._id,
      matchScore: 75,
      verdict: 'Good Match',
      reasoning: 'test',
    });

    await User.updateOne(
      { _id: testUserId },
      { $push: { skippedJobs: jobF._id } }
    );

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);

    // ORACLE FROM SPEC: A + B = 2. C salary, D location, E matchRecord, F skipped.
    expect(res.body.count).toBe(2);

    // PARITY: email algorithm (mirrors onlyjobs-background/src/jobs/matchJobs.ts).
    // If the endpoint and email diverge, both assertions below cannot both pass.
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
    const recentJobs = await JobListing.find({ postedDate: { $gte: fifteenDaysAgo } });
    const freshUser = await User.findById(testUserId);
    const prefFiltered = applyPreferenceFilters(recentJobs, freshUser!.preferences);
    const existingMatchIds = new Set(
      (await MatchRecord.find({ userId: testUserId }, { jobId: 1 })).map(
        (m) => toStr(m.jobId)
      )
    );
    const skippedJobIds = new Set(
      (freshUser!.skippedJobs || []).map((id) => toStr(id))
    );
    const emailCount = prefFiltered.kept.filter(
      (job) =>
        !existingMatchIds.has(toStr(job._id)) &&
        !skippedJobIds.has(toStr(job._id))
    ).length;

    expect(res.body.count).toBe(emailCount);
  });
});

// ---------------------------------------------------------------------------
// 9. candidates capped at 5
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — candidates capped at 5', () => {
  it('returns at most 5 candidates even when more are eligible', async () => {
    await makeUser();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createJob({ title: `Job ${i}` })
      )
    );

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);
    expect(res.body.count).toBe(10);
    expect(res.body.candidates.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 10. candidates contain only display fields
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — candidate fields', () => {
  it('candidates contain only display fields, no score/verdict/reasoning', async () => {
    await makeUser();
    await createJob({ title: 'Display Test Job' });

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);
    expect(res.body.candidates.length).toBeGreaterThan(0);

    const candidate = res.body.candidates[0];
    expect(candidate).toHaveProperty('title');
    expect(candidate).toHaveProperty('company');
    expect(candidate).toHaveProperty('location');
    expect(candidate).toHaveProperty('salary');
    expect(candidate).toHaveProperty('postedDate');

    // Must NOT have internal fields
    expect(candidate).not.toHaveProperty('score');
    expect(candidate).not.toHaveProperty('matchScore');
    expect(candidate).not.toHaveProperty('verdict');
    expect(candidate).not.toHaveProperty('reasoning');
    expect(candidate).not.toHaveProperty('description');
    expect(candidate).not.toHaveProperty('tags');
    expect(candidate).not.toHaveProperty('source');
  });
});
