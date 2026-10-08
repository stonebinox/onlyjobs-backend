jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

// Passthrough mock — delegates to real implementation by default.
// D3 overrides it to throw (fail-open test); beforeEach restores passthrough.
jest.mock('../utils/capNewJobsByCompany', () => {
  const actual = jest.requireActual('../utils/capNewJobsByCompany') as Record<string, unknown> & {
    capNewJobsByCompany: (...args: unknown[]) => unknown;
  };
  return {
    __esModule: true,
    ...actual,
    capNewJobsByCompany: jest.fn((...args: unknown[]) => actual.capNewJobsByCompany(...args)),
  };
});

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import JobListing from '../models/JobListing';
import MatchRecord from '../models/MatchRecord';
import matchRoutes from '../routes/matchRoutes';
import { applyPreferenceFilters } from '../utils/preferenceFilters';
import { capNewJobsByCompany, COMPANY_CAP_K } from '../utils/capNewJobsByCompany';

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
  // Restore capNewJobsByCompany passthrough (guarded against D3 leaving it throwing)
  const mockedCap = capNewJobsByCompany as unknown as jest.Mock;
  const realCapMod = jest.requireActual('../utils/capNewJobsByCompany') as {
    capNewJobsByCompany: (...args: unknown[]) => unknown;
  };
  mockedCap.mockImplementation((...args: unknown[]) =>
    realCapMod.capNewJobsByCompany(...args)
  );
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
    const eligibleJobs = prefFiltered.kept.filter(
      (job) =>
        !existingMatchIds.has(toStr(job._id)) &&
        !skippedJobIds.has(toStr(job._id))
    );
    // Apply per-company cap — mirrors the nightly email path which caps after exclusions.
    // Without this, the oracle diverges from the endpoint once a fixture has >K same-company jobs.
    const emailCount = capNewJobsByCompany(eligibleJobs, COMPANY_CAP_K).length;

    expect(res.body.count).toBe(emailCount);
  });
});

// ---------------------------------------------------------------------------
// 9. candidates capped at 5
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — candidates capped at 5', () => {
  it('returns at most 5 candidates even when more are eligible', async () => {
    await makeUser();
    // Each job from a distinct company so none are capped by the per-company cap (K=3)
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createJob({ title: `Job ${i}`, company: `Company${i}`, url: `https://example.com/job${i}`, dedupKey: `https://example.com/job${i}` })
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

// ---------------------------------------------------------------------------
// 11. CAP SELECTS NEWEST — selection assertion, not just count
//
// Contract: candidates = first 5 of the CAPPED set in newest-first order.
// A naive slice(0, K) without sorting would retain the wrong 3.
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — cap selects newest K (not arbitrary K)', () => {
  it('with K+1 same-company jobs, the OLDEST is absent from candidates and count=K', async () => {
    await makeUser();
    const DAY = 86400000;

    // 4 same-company jobs, distinct postedDates. Inserted oldest-first to challenge
    // a naive "take first 3 from query result" implementation.
    await createJob({
      title: 'CapSel Oldest', company: 'AcmeSel',
      url: 'https://acme-sel.com/d', postedDate: new Date(Date.now() - 4 * DAY),
    });
    await createJob({
      title: 'CapSel Third', company: 'AcmeSel',
      url: 'https://acme-sel.com/c', postedDate: new Date(Date.now() - 3 * DAY),
    });
    await createJob({
      title: 'CapSel Second', company: 'AcmeSel',
      url: 'https://acme-sel.com/b', postedDate: new Date(Date.now() - 2 * DAY),
    });
    await createJob({
      title: 'CapSel Newest', company: 'AcmeSel',
      url: 'https://acme-sel.com/a', postedDate: new Date(Date.now() - 1 * DAY),
    });

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);

    // Oracle from spec: K=3 newest retained, 1 oldest dropped
    expect(res.body.count).toBe(3);

    const candidateTitles = (res.body.candidates as Array<{ title: string }>).map((c) => c.title);

    // Oldest must be absent — this assertion FAILS a naive "first K without sort"
    expect(candidateTitles).not.toContain('CapSel Oldest');

    // Newest must be present — confirms direction of the sort
    expect(candidateTitles).toContain('CapSel Newest');
  });

  it('candidates are in newest-first order within the capped set', async () => {
    await makeUser();
    const DAY = 86400000;

    // 3 same-company jobs (≤ K, all retained), inserted in reverse-date order.
    // A "first 5 from DB" without sort could return them insertion-order (oldest-first here).
    await createJob({
      title: 'AcmeOrd Oldest', company: 'AcmeOrd',
      url: 'https://acme-ord.com/1', postedDate: new Date(Date.now() - 3 * DAY),
    });
    await createJob({
      title: 'AcmeOrd Middle', company: 'AcmeOrd',
      url: 'https://acme-ord.com/2', postedDate: new Date(Date.now() - 2 * DAY),
    });
    await createJob({
      title: 'AcmeOrd Newest', company: 'AcmeOrd',
      url: 'https://acme-ord.com/3', postedDate: new Date(Date.now() - 1 * DAY),
    });

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);
    expect(res.body.count).toBe(3);

    const candidates = res.body.candidates as Array<{ title: string }>;
    const idxNewest = candidates.findIndex((c) => c.title === 'AcmeOrd Newest');
    const idxOldest = candidates.findIndex((c) => c.title === 'AcmeOrd Oldest');

    expect(idxNewest).toBeGreaterThanOrEqual(0);
    expect(idxOldest).toBeGreaterThanOrEqual(0);

    // Newest must appear BEFORE oldest (newest-first global order)
    expect(idxNewest).toBeLessThan(idxOldest);
  });
});

// ---------------------------------------------------------------------------
// 12. NORMALIZATION VARIANTS share one cap bucket in the preview endpoint
//
// Contract: "Acme", "Acme Inc.", "ACME, INC." all normalize to "acme" and share one bucket.
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — normalization variants share one bucket', () => {
  it('"Acme"/"Acme Inc."/"ACME, INC." all normalize to same bucket; 4 variants capped to K=3', async () => {
    await makeUser();
    const DAY = 86400000;

    // 4 jobs whose company names all normalize to "acme". Distinct postedDates.
    await createJob({
      title: 'Norm Job Newest', company: 'Acme',
      url: 'https://norm.com/1', postedDate: new Date(Date.now() - 1 * DAY),
    });
    await createJob({
      title: 'Norm Job Second', company: 'Acme Inc.',
      url: 'https://norm.com/2', postedDate: new Date(Date.now() - 2 * DAY),
    });
    await createJob({
      title: 'Norm Job Third', company: 'ACME, INC.',
      url: 'https://norm.com/3', postedDate: new Date(Date.now() - 3 * DAY),
    });
    await createJob({
      title: 'Norm Job Oldest', company: 'Acme',
      url: 'https://norm.com/4', postedDate: new Date(Date.now() - 4 * DAY),
    });

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);

    // Oracle: 4 variants share one "acme" bucket → cap to K=3
    expect(res.body.count).toBe(3);

    // Oldest must be excluded (normalization bucketed all 4 together)
    const candidateTitles = (res.body.candidates as Array<{ title: string }>).map((c) => c.title);
    expect(candidateTitles).not.toContain('Norm Job Oldest');
  });
});

// ---------------------------------------------------------------------------
// 13. PARITY ORACLE WITH CAP — demonstrates that omitting the cap from the
//     emailCount oracle causes it to diverge from the endpoint for N>K eligible
//     same-company jobs.
//
//     This test would FAIL against the old (pre-fix) oracle that did not apply
//     capNewJobsByCompany to the eligible set before counting.
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — parity oracle applies cap', () => {
  it('count matches capped emailCount for N > K eligible same-company jobs', async () => {
    await makeUser();
    const DAY = 86400000;

    // 5 same-company eligible jobs (N=5 > K=3).
    // Old oracle (no cap): emailCount=5. Correct oracle (with cap): emailCount=3.
    // The endpoint must return count=3; the parity assertion below catches divergence.
    for (let i = 1; i <= 5; i++) {
      await createJob({
        title: `Parity Job ${i}`,
        company: 'ParityCo',
        url: `https://parity.com/${i}`,
        postedDate: new Date(Date.now() - i * DAY),
      });
    }

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);

    // Oracle from spec: 5 same-company jobs capped to K=3
    expect(res.body.count).toBe(3);

    // Parity: independently recompute with the CAPPED email algorithm.
    // Omitting capNewJobsByCompany here (old oracle) returns 5, not 3, and the parity
    // assertion would pass against a broken endpoint — exposing the stale oracle.
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
    const recentJobs = await JobListing.find({ postedDate: { $gte: fifteenDaysAgo } });
    const freshUser = await User.findById(testUserId);
    const prefFiltered = applyPreferenceFilters(recentJobs, freshUser!.preferences);
    const existingMatchIds = new Set(
      (await MatchRecord.find({ userId: testUserId }, { jobId: 1 })).map((m) => toStr(m.jobId))
    );
    const skippedJobIds = new Set(
      (freshUser!.skippedJobs || []).map((id: unknown) => toStr(id as mongoose.Types.ObjectId))
    );
    const eligibleJobs = prefFiltered.kept.filter(
      (job) =>
        !existingMatchIds.has(toStr(job._id)) &&
        !skippedJobIds.has(toStr(job._id))
    );
    // Apply cap — this is what the old oracle was missing
    const emailCount = capNewJobsByCompany(eligibleJobs, COMPANY_CAP_K).length;

    expect(res.body.count).toBe(emailCount);
  });
});

// ---------------------------------------------------------------------------
// D3. FAIL-OPEN ENDPOINT — capNewJobsByCompany throws → uncapped fallback
//
// Contract: if capNewJobsByCompany throws, the endpoint is fail-open and
// returns the UNCAPPED eligible set (status 200, shouldShow true) rather than
// hiding the corpus or erroring out. A [CAP-FAILOPEN] warning must be logged.
// Oracle: count === uncapped eligible count (N > K same-company jobs).
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — fail-open when cap helper throws', () => {
  it('D3: capNewJobsByCompany throws → status 200, shouldShow true, count === uncapped eligible count', async () => {
    await makeUser(); // matchingEnabled:false, reason:auto_low_balance, balance:0.10
    const DAY = 86400000;

    // Seed 5 same-company eligible jobs (N=5 > K=3). Correct ordering would cap to 3.
    // With cap throwing, fail-open returns all 5.
    for (let i = 1; i <= 5; i++) {
      await createJob({
        title: `FailOpen Job ${i}`,
        company: 'FailOpenCo',
        url: `https://failopen.test/${i}`,
        postedDate: new Date(Date.now() - i * DAY),
      });
    }

    const mockedCap = capNewJobsByCompany as unknown as jest.Mock;
    const realCapMod = jest.requireActual('../utils/capNewJobsByCompany') as {
      capNewJobsByCompany: (...args: unknown[]) => unknown;
    };

    mockedCap.mockImplementation(() => {
      throw new Error('simulated cap helper failure for D3');
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await request(testApp).get('/api/matches/out-of-credit-preview');

      // Oracle: fail-open → endpoint does NOT crash; status 200
      expect(res.status).toBe(200);
      expect(res.body.shouldShow).toBe(true);

      // Oracle: count === UNCAPPED eligible count (5), NOT the capped count (3).
      // A fail-open that returned 0 or threw would violate the contract.
      expect(res.body.count).toBe(5);

      // Oracle: the implementation must log a warning about the failed cap.
      const logged = warnSpy.mock.calls.length > 0 || errorSpy.mock.calls.length > 0;
      expect(logged).toBe(true);

      // L3: the warning must contain "[CAP-FAILOPEN]" — an unrelated log cannot satisfy this.
      const capWarnEmitted = warnSpy.mock.calls.some((callArgs) =>
        callArgs.some((arg) => typeof arg === 'string' && arg.includes('[CAP-FAILOPEN]'))
      );
      expect(capWarnEmitted).toBe(true);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      // Restore passthrough (belt-and-suspenders; beforeEach also restores)
      mockedCap.mockImplementation((...args: unknown[]) =>
        realCapMod.capNewJobsByCompany(...args)
      );
    }
  });
});

// ---------------------------------------------------------------------------
// D4. CAP-AFTER-EXCLUSIONS (preview) — existing-match/skipped jobs do not
//     consume a cap slot.
//
// Contract: the exclusion step (remove existing MatchRecords and skippedJobs)
// MUST run BEFORE the cap. With 4 same-company jobs where the NEWEST has an
// existing MatchRecord:
//   - Correct ordering (exclude first): 3 unmatched jobs remain → cap K=3 → count=3
//   - Wrong ordering (cap first): cap keeps 3 newest (including the matched one) →
//     exclude matched → 2 remain → count=2
// Oracle: count === 3, not 2. Fails if cap runs before exclusion.
// ---------------------------------------------------------------------------

describe('GET /api/matches/out-of-credit-preview — exclusion happens before cap (D4)', () => {
  it('D4: newest job already matched → 3 remaining unmatched survive the cap (not 2)', async () => {
    await makeUser(); // matchingEnabled:false, reason:auto_low_balance, balance:0.10
    const DAY = 86400000;

    // 4 same-company jobs. The NEWEST (1 day ago) has a MatchRecord.
    // Correct ordering: exclude newest first → 3 left (2d, 3d, 4d) → cap K=3 → 3 (no cap needed).
    // Wrong ordering: cap first → keep 3 newest (1d, 2d, 3d) → exclude 1d → 2 remain.
    const newest = await createJob({
      title: 'D4 Newest (already matched)',
      company: 'ExclusionCo',
      url: 'https://exclusion.test/newest',
      postedDate: new Date(Date.now() - 1 * DAY),
    });
    await createJob({
      title: 'D4 Second',
      company: 'ExclusionCo',
      url: 'https://exclusion.test/second',
      postedDate: new Date(Date.now() - 2 * DAY),
    });
    await createJob({
      title: 'D4 Third',
      company: 'ExclusionCo',
      url: 'https://exclusion.test/third',
      postedDate: new Date(Date.now() - 3 * DAY),
    });
    await createJob({
      title: 'D4 Oldest',
      company: 'ExclusionCo',
      url: 'https://exclusion.test/oldest',
      postedDate: new Date(Date.now() - 4 * DAY),
    });

    // Newest job already has a MatchRecord for this user — must be excluded BEFORE the cap.
    await MatchRecord.create({
      userId: testUserId,
      jobId: newest._id,
      matchScore: 80,
      verdict: 'Good Match',
      reasoning: 'D4 pre-existing match',
    });

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);

    // Oracle from spec: exclusion removes the newest, leaving 3 unmatched jobs.
    // Cap K=3 applied to 3 → no removal. count must be 3.
    // Wrong ordering (cap before exclusion) gives count=2 — this assertion catches it.
    expect(res.body.count).toBe(3);

    // Confirm the already-matched job is absent from candidates
    const candidateTitles = (res.body.candidates as Array<{ title: string }>).map((c) => c.title);
    expect(candidateTitles).not.toContain('D4 Newest (already matched)');
  });
});
