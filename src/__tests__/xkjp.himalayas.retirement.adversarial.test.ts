// xkjp.himalayas.retirement.adversarial.test.ts (backend)
// Adversarial tests for Himalayas source retirement — backend API layer.
// Oracle: CONTRACT in bd task onlyjobs-xkjp — NOT derived from implementation bodies.
// FORBIDDEN files: jobController.ts, outOfCreditPreviewController.ts, scrapers.ts,
//   scrapeJobs.ts, matchJobs.ts, nightlyOrchestrator.ts.
// DISCLOSURE section at the bottom.
//
// Uses the global MongoMemoryServer from src/__tests__/setup.ts (setupFilesAfterEnv).

jest.mock('../middleware/authMiddleware', () => ({
  protect: (req: any, res: any, next: any) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: 'Not authorized' });
      return;
    }
    next();
  },
}));

jest.mock('../services/matchingService', () => ({
  matchUserToJob: jest.fn(),
  matchUserToJobStable: jest.fn(),
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import JobListing from '../models/JobListing';
import MatchRecord, { Freshness } from '../models/MatchRecord';
import jobRoutes from '../routes/jobRoutes';
import matchRoutes from '../routes/matchRoutes';
import { matchUserToJob } from '../services/matchingService';

const mockMatchUserToJob = matchUserToJob as jest.Mock;

// ============================================================
// Test app (auth-injected) — mirrors allJobs.test.ts structure
// ============================================================

let currentUser: any = null;
let previewUserId: mongoose.Types.ObjectId;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.headers.authorization = 'Bearer test-token';
  req.user = currentUser;
  next();
});
testApp.use('/api/jobs', jobRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

// ============================================================
// Preview app — matchRoutes, auth-injected with previewUserId
// ============================================================
const previewApp = express();
previewApp.use(express.json());
previewApp.use((req: any, _res: any, next: any) => {
  req.headers.authorization = 'Bearer test-token';
  req.user = { _id: previewUserId };
  next();
});
previewApp.use('/api/matches', matchRoutes);
previewApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

// ============================================================
// Seed helpers
// ============================================================

async function makePreviewUser() {
  // Eligible for the out-of-credit preview:
  //   matchingEnabled: false + reason: auto_low_balance + balance < 0.30 (0.10).
  // This mirrors the production auto-disable state set by the nightly matcher.
  return User.create({
    _id: previewUserId,
    name: 'XKJP Preview Test User',
    email: `xkjp-preview-${Date.now()}-${Math.random()}@example.com`,
    password: 'hashed',
    isVerified: true,
    walletBalance: 0.10,
    matchingDisabledReason: 'auto_low_balance',
    skippedJobs: [],
    resume: {
      summary: 'Experienced engineer',
      skills: ['TypeScript', 'Node.js'],
      experience: ['5 years at Acme'],
      education: [],
      certifications: [],
      languages: [],
      projects: [],
      achievements: [],
      volunteerExperience: [],
      interests: [],
    },
    preferences: {
      jobTypes: [],
      location: [],
      remoteOnly: false,
      minSalary: 0,
      industries: [],
      minScore: 30,
      matchingEnabled: false,
    },
  });
}

const BASE_USER = {
  name: 'XKJP Test User',
  password: 'hashed',
  isVerified: true,
  walletBalance: 1.0,
  resume: {
    summary: 'Experienced engineer',
    skills: ['TypeScript', 'Node.js'],
    experience: ['5 years at Acme'],
    education: [],
    certifications: [],
    languages: [],
    projects: [],
    achievements: [],
    volunteerExperience: [],
    interests: [],
  },
  preferences: {
    jobTypes: [],
    location: [],
    remoteOnly: false,
    minSalary: 0,
    industries: [],
    minScore: 30,
    matchingEnabled: true,
  },
};

async function createUser(overrides: Record<string, any> = {}) {
  const userId = new mongoose.Types.ObjectId();
  return User.create({
    _id: userId,
    email: `xkjp-${Date.now()}-${Math.random()}@example.com`,
    ...BASE_USER,
    ...overrides,
  });
}

let _jobSeq = 0;
function createJob(overrides: Record<string, any> = {}) {
  _jobSeq++;
  const postedDate = new Date();
  postedDate.setDate(postedDate.getDate() - 3); // within 15-day window
  return JobListing.create({
    title: `Engineer #${_jobSeq}`,
    company: `Company${_jobSeq}`,
    location: ['Remote'],
    source: 'RemoteOK',
    description: 'Build great software',
    url: `https://example.com/job-${Date.now()}-${_jobSeq}`,
    postedDate,
    scrapedDate: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  currentUser = null;
  previewUserId = new mongoose.Types.ObjectId();
  mockMatchUserToJob.mockReset();
});

// ============================================================
// T6: GET /api/jobs EXCLUDES Himalayas
// ============================================================

describe('T6: GET /api/jobs excludes Himalayas', () => {
  it('T6a: Himalayas listings absent from the paginated job list and do not inflate total', async () => {
    // Oracle (contract §6): corpus-scan queries (GET /api/jobs) exclude RETIRED_SOURCES.
    // Wrong impl (no filter): Himalayas jobs appear in the list → assertion FAILS.
    const user = await createUser();
    currentUser = user;

    const liveJob = await createJob({ source: 'RemoteOK', company: 'LiveCo', title: 'Live Engineer' });
    await createJob({ source: 'Himalayas', company: 'HimCo', title: 'Himalayas Engineer' });

    const res = await request(testApp).get('/api/jobs');
    expect(res.status).toBe(200);

    // T6a-i: only the live job appears
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0]._id).toBe((liveJob._id as mongoose.Types.ObjectId).toString());

    // T6a-ii: pagination total counts only non-retired listings
    // Wrong impl: total=2 (includes Himalayas) → FAILS.
    expect(res.body.total).toBe(1);
  });

  it('T6b: ?source=Himalayas → empty list, total 0 (exclusion merged with user filter via $and, not overwrite)', async () => {
    // Oracle: a user explicitly requesting source=Himalayas gets 0 results.
    // The exclusion must be MERGED with the source filter (via $and), not overwrite it —
    // contract: "the exclusion is merged with the user's source filter via $and, not overwritten."
    const user = await createUser();
    currentUser = user;

    await createJob({ source: 'RemoteOK' });
    await createJob({ source: 'Himalayas' });

    const res = await request(testApp).get('/api/jobs?source=Himalayas');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it('T6c: ?source=RemoteOK still returns live-source jobs (exclusion does not overwrite the filter)', async () => {
    // Oracle: filtering by a live source still works after retirement.
    // A wrong impl that replaces the source filter with RETIRED_SOURCES exclusion
    // would also suppress live-source filtering → would return ALL non-Himalayas jobs
    // regardless of the ?source param. This test catches that.
    const user = await createUser();
    currentUser = user;

    const remoteOKJob = await createJob({ source: 'RemoteOK', title: 'RemoteOK Job' });
    await createJob({ source: 'WeWorkRemotely', title: 'WeWorkRemotely Job' });
    await createJob({ source: 'Himalayas', title: 'Himalayas Job' });

    const res = await request(testApp).get('/api/jobs?source=RemoteOK');
    expect(res.status).toBe(200);

    // Only the RemoteOK job — Himalayas excluded AND WeWorkRemotely filtered out.
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0]._id).toBe((remoteOKJob._id as mongoose.Types.ObjectId).toString());
    expect(res.body.total).toBe(1);
  });

  it('T6d: distinct sources picker (sources array) omits Himalayas', async () => {
    // Oracle (contract §6): the source-picker in GET /api/jobs response excludes Himalayas.
    const user = await createUser();
    currentUser = user;

    await createJob({ source: 'RemoteOK' });
    await createJob({ source: 'WeWorkRemotely' });
    await createJob({ source: 'Himalayas' });

    const res = await request(testApp).get('/api/jobs');
    expect(res.status).toBe(200);

    const sources: string[] = res.body.sources;
    expect(sources).toContain('RemoteOK');
    expect(sources).toContain('WeWorkRemotely');
    // Himalayas must NOT appear in the sources picker.
    expect(sources).not.toContain('Himalayas');
  });
});

// ============================================================
// T7: ID-based access preserved for Himalayas jobs
// ============================================================

describe('T7: POST /api/jobs/:jobId/match still serves a Himalayas jobId (on-demand-by-id)', () => {
  it('T7: Himalayas job matched on-demand → 200, NOT 404 (ID lookups skip the corpus exclusion)', async () => {
    // Oracle (contract §7): only corpus-SCAN queries exclude RETIRED_SOURCES.
    // ID-based lookups (POST /api/jobs/:jobId/match) must serve any jobId the user holds,
    // regardless of source.
    //
    // Wrong impl (RETIRED_SOURCES filter applied to ID lookup): Himalayas job returns 404
    //   → assertion FAILS (exposing the bug that strands existing Himalayas jobs).
    const user = await createUser();
    currentUser = user;

    // A recent Himalayas job the user has not yet matched.
    const himalayas = await createJob({
      source: 'Himalayas',
      title: 'Himalayas Engineer',
      company: 'HimCo',
    });

    mockMatchUserToJob.mockResolvedValue({
      matchScore: 78,
      verdict: 'Good match',
      reasoning: 'Solid overlap',
      freshness: Freshness.FRESH,
    });

    const res = await request(testApp).post(`/api/jobs/${himalayas._id}/match`);

    // Oracle: NOT 404 — the ID lookup must succeed regardless of source.
    // A 404 here means the implementation incorrectly applies RETIRED_SOURCES to ID-based lookups.
    expect(res.status).not.toBe(404);

    // Accept 200 (new match created) or 400 (duplicate/gate) — both prove the job was found.
    // 404 is the only forbidden outcome from the oracle.
    expect([200, 400]).toContain(res.status);
  });
});

// ============================================================
// T8: getPublicStats and getAvailableJobCount exclude Himalayas
// ============================================================

describe('T8: GET /api/jobs/stats and GET /api/jobs/available-count exclude Himalayas', () => {
  it('T8a: GET /api/jobs/stats jobCount equals live-source count (excludes Himalayas)', async () => {
    // Oracle (contract §6): getPublicStats must exclude RETIRED_SOURCES from jobCount.
    // Seed 2 live + 3 Himalayas → jobCount must be 2, not 5.
    await createJob({ source: 'RemoteOK' });
    await createJob({ source: 'WeWorkRemotely' });
    await createJob({ source: 'Himalayas' });
    await createJob({ source: 'Himalayas' });
    await createJob({ source: 'Himalayas' });

    const res = await request(testApp).get('/api/jobs/stats');
    expect(res.status).toBe(200);

    // Contract: jobCount excludes Himalayas.
    // Wrong impl (no filter): jobCount=5 → FAILS.
    // Wrong impl (excludes everything): jobCount=0 → FAILS.
    expect(res.body.jobCount).toBe(2);
  });

  it('T8b: GET /api/jobs/available-count (count) equals live-source count (excludes Himalayas)', async () => {
    // Oracle (contract §6): getAvailableJobCount must exclude RETIRED_SOURCES.
    // Seed 3 live + 2 Himalayas → count must be 3, not 5.
    await createJob({ source: 'RemoteOK' });
    await createJob({ source: 'WeWorkRemotely' });
    await createJob({ source: 'Arbeitnow' });
    await createJob({ source: 'Himalayas' });
    await createJob({ source: 'Himalayas' });

    const res = await request(testApp).get('/api/jobs/available-count');
    expect(res.status).toBe(200);

    // The apiClient uses `data.count`; assert via res.body.count.
    // Contract: count excludes Himalayas.
    // Wrong impl: count=5 → FAILS. Wrong impl (excludes everything): count=0 → FAILS.
    expect(res.body.count).toBe(3);
  });

  it('T8c: N live + M Himalayas — both endpoints return N (parameterized)', async () => {
    // Additional assertion: whichever N and M are used, the result must be N not N+M.
    const N = 4;
    const M = 5;

    for (let i = 0; i < N; i++) {
      await createJob({ source: 'RemoteOK', company: `LiveCo${i}` });
    }
    for (let j = 0; j < M; j++) {
      await createJob({ source: 'Himalayas', company: `HimCo${j}` });
    }

    const statsRes = await request(testApp).get('/api/jobs/stats');
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.jobCount).toBe(N);

    const countRes = await request(testApp).get('/api/jobs/available-count');
    expect(countRes.status).toBe(200);
    expect(countRes.body.count).toBe(N);
  });
});

// ============================================================
// T9: out-of-credit preview excludes Himalayas from candidate corpus
// ============================================================

describe('T9: GET /api/matches/out-of-credit-preview excludes Himalayas', () => {
  it('T9a: mixed Himalayas + live-source jobs → count and candidates include ONLY live-source jobs', async () => {
    // Oracle (contract §5): the preview endpoint's candidate corpus excludes
    // RETIRED_SOURCES (["Himalayas"]), same as the nightly matcher.
    // Wrong impl (no filter): count=4 (includes Himalayas) → FAILS.
    // Wrong impl (excludes everything): count=0 → FAILS.
    await makePreviewUser();

    await createJob({ source: 'RemoteOK', title: 'Live Job A' });
    await createJob({ source: 'WeWorkRemotely', title: 'Live Job B', company: 'WWR Co' });
    await createJob({ source: 'Himalayas', title: 'Himalayas Job 1', company: 'HimCo1' });
    await createJob({ source: 'Himalayas', title: 'Himalayas Job 2', company: 'HimCo2' });

    const res = await request(previewApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);

    // Oracle: exactly 2 live-source jobs. The 2 Himalayas jobs must be excluded.
    expect(res.body.count).toBe(2);

    // Candidates must not contain any Himalayas job.
    const candidateTitles = (res.body.candidates as Array<{ title: string }>).map((c) => c.title);
    expect(candidateTitles).not.toContain('Himalayas Job 1');
    expect(candidateTitles).not.toContain('Himalayas Job 2');
    // Both live jobs should appear (≤5 total, none are capped).
    expect(candidateTitles).toContain('Live Job A');
    expect(candidateTitles).toContain('Live Job B');
  });

  it('T9b: Himalayas-only eligible corpus → count 0, empty candidates', async () => {
    // Oracle (contract §5): when all in-window listings are from Himalayas, the
    // preview corpus is empty (count=0, candidates=[]). shouldShow remains true
    // because the user IS genuinely auto-disabled — eligibility is about the user,
    // not the job count. A count > 0 here means Himalayas was not excluded (FAILS).
    // If shouldShow is false, it means the implementation is gating on count=0 rather
    // than user eligibility — that is a FINDING.
    await makePreviewUser();

    await createJob({ source: 'Himalayas', title: 'Himalayas Only 1', company: 'HimCo1' });
    await createJob({ source: 'Himalayas', title: 'Himalayas Only 2', company: 'HimCo2' });
    await createJob({ source: 'Himalayas', title: 'Himalayas Only 3', company: 'HimCo3' });

    const res = await request(previewApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);

    // Oracle: Himalayas excluded → corpus is empty.
    expect(res.body.count).toBe(0);
    expect(res.body.candidates).toHaveLength(0);

    // Oracle: user eligibility is independent of corpus size.
    expect(res.body.shouldShow).toBe(true);
  });
});

// ============================================================
// DISCLOSURE
// ============================================================
//
// Files opened (read in full):
//   - src/__tests__/allJobs.test.ts
//       — testApp construction (auth middleware mock, express setup, jobRoutes),
//         createUser/createJob helpers, mockMatchUserToJob pattern, Freshness import.
//       — USED: auth mock shape, testApp pattern, helper shapes, Freshness.FRESH.
//   - src/__tests__/outOfCreditPreview.test.ts
//       — makeUser fixture, createJob fixture, response field names (res.body.count).
//   - src/routes/jobRoutes.ts
//       — confirmed route paths: /available-count (public), /stats (public),
//         / (protected), /:jobId/match (protected).
//   - src/routes/matchRoutes.ts
//       — no job-by-id GET route found (confirmed no GET /api/jobs/:jobId route).
//   - src/constants/retiredSources.ts (read directly — allowed, is NOT a forbidden file)
//       — confirmed RETIRED_SOURCES = ["Himalayas"].
//   - src/__tests__/setup.ts
//       — confirmed global MongoMemoryServer + afterEach deleteMany pattern.
//   - frontend/src/lib/apiClient.ts (partial)
//       — confirmed response shapes: /jobs/stats → { jobCount, userCount },
//         /jobs/available-count → { count }.
//   - jest.config.ts
//       — confirmed setupFilesAfterEnv includes setup.ts.
//
// Incidental observations:
//   - grep on backend showed jobController.ts and outOfCreditPreviewController.ts
//     import RETIRED_SOURCES from the constants file. No implementation bodies read.
//   - The frontend test `kjc.onboarding.smoke.test.tsx` confirmed { jobCount: 0, userCount: 0 }
//     as the stats response shape.
//   - T7: there is NO GET /api/jobs/:jobId route in the backend. The "ID-based access"
//     referred to in contract §7 maps to POST /api/jobs/:jobId/match (matchJobOnDemand).
//     If the implementation adds a GET /api/jobs/:jobId route (not currently present),
//     an additional T7 variant should be added. This is reported as a FINDING: the
//     contract mentions "GET /api/jobs/:jobId" but no such route exists — only
//     POST /api/jobs/:jobId/match covers the "id lookup" scenario tested here.
//
// T9 addition (GAP 2 gap-fill):
//   - src/__tests__/outOfCreditPreview.test.ts (read in full for this gap-fill)
//       — makeUser fixture (matchingEnabled:false, reason:auto_low_balance, balance:0.10),
//         previewApp structure (matchRoutes at /api/matches), shouldShow/count/candidates
//         response fields, T9b shouldShow:true oracle when count=0 (not explicitly tested
//         in existing suite — treating failure as a FINDING per task brief).
//       — USED: previewApp shape, makePreviewUser field set, response oracle names.
//   - Incidental: from reading outOfCreditPreview.test.ts, the endpoint returns
//       { shouldShow, reason, count, candidates, walletBalance, dailyMatchCost,
//         onDemandMatchCost } when shouldShow:true. count and candidates are the
//         key oracle fields for T9.
//
// No production (non-test) file was edited.
