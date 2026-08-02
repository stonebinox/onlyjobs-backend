/**
 * Adversarial tests for GET /api/matches/tracker.
 * Oracle: the contract spec delivered in the test-authorship prompt — no production files read.
 *
 * Forbidden files NOT opened:
 *   - frontend/src/pages/tracker.tsx
 *   - frontend/src/utils/tracker-utils.ts
 *   - backend/src/controllers/matchController.ts
 *   - backend/src/__tests__/tracker.test.ts   (implementer's own smoke test)
 *
 * Harness pattern derived from matchOwnership.test.ts and wallet.test.ts.
 * MongoMemoryServer is provided globally by src/__tests__/setup.ts.
 */

// Mocks must be hoisted before any imports.
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({}),
}));

jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import MatchRecord, { Freshness } from '../models/MatchRecord';
import JobListing from '../models/JobListing';
import User from '../models/User';
import matchRoutes from '../routes/matchRoutes';

// ── Test app ─────────────────────────────────────────────────────────────────
// currentUserId is mutable so individual tests can switch identity to test
// cross-user isolation (same pattern as matchOwnership.test.ts ownerUserId).
let currentUserId: mongoose.Types.ObjectId;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.user = { _id: currentUserId };
  next();
});
testApp.use('/api/matches', matchRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

// ── Per-test state ────────────────────────────────────────────────────────────
let ownerUserId: mongoose.Types.ObjectId;
let otherUserId: mongoose.Types.ObjectId;

beforeEach(() => {
  ownerUserId = new mongoose.Types.ObjectId();
  otherUserId = new mongoose.Types.ObjectId();
  currentUserId = ownerUserId;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createJobListing() {
  return JobListing.create({
    title: 'Software Engineer',
    company: 'TestCo',
    location: ['Remote'],
    source: 'test',
    description: 'A test job description',
    url: 'https://example.com/job',
    postedDate: new Date(),
  });
}

async function createAppliedMatch(
  userId: mongoose.Types.ObjectId,
  jobId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {}
) {
  return MatchRecord.create({
    userId,
    jobId,
    matchScore: 80,
    verdict: 'Good match',
    reasoning: 'Test reasoning',
    freshness: Freshness.FRESH,
    clicked: false,
    skipped: false,
    applied: true,
    appliedAt: new Date(),
    ...overrides,
  });
}

async function createUser(userId: mongoose.Types.ObjectId, minScore = 30) {
  return User.create({
    _id: userId,
    name: 'Test User',
    email: `tracker-adv-${userId.toString()}@example.com`,
    password: 'hashed',
    resume: {
      skills: [],
      experience: [],
      education: [],
      summary: '',
    },
    preferences: {
      jobTypes: [],
      location: [],
      remoteOnly: false,
      minSalary: 0,
      industries: [],
      minScore,
      matchingEnabled: true,
    },
    walletBalance: 0,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/matches/tracker
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/matches/tracker', () => {
  // ── 1. Basic shape ──────────────────────────────────────────────────────────

  it('returns 200 with empty array when the user has no applied records', async () => {
    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('returns 200 with the applied record when one exists', async () => {
    const job = await createJobListing();
    await createAppliedMatch(ownerUserId, (job as any)._id);

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('returns multiple applied records for a single user', async () => {
    const j1 = await createJobListing();
    const j2 = await createJobListing();
    const j3 = await createJobListing();
    await createAppliedMatch(ownerUserId, (j1 as any)._id);
    await createAppliedMatch(ownerUserId, (j2 as any)._id);
    await createAppliedMatch(ownerUserId, (j3 as any)._id);

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  // ── 2. NON-APPLIED EXCLUDED ─────────────────────────────────────────────────

  it('excludes records with applied=false [contract: non-applied excluded]', async () => {
    const job = await createJobListing();
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: (job as any)._id,
      matchScore: 75,
      verdict: 'Good',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: false,
    });

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('excludes records with applied=null [contract: non-applied excluded]', async () => {
    const job = await createJobListing();
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: (job as any)._id,
      matchScore: 75,
      verdict: 'Good',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: null,
    });

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('returns only applied=true entries when the user has mixed records [contract: non-applied excluded]', async () => {
    const j1 = await createJobListing();
    const j2 = await createJobListing();
    const j3 = await createJobListing();

    const appliedMatch = await createAppliedMatch(ownerUserId, (j1 as any)._id);

    await MatchRecord.create({
      userId: ownerUserId,
      jobId: (j2 as any)._id,
      matchScore: 75, verdict: 'Good', reasoning: 'Test',
      freshness: Freshness.FRESH, clicked: false, skipped: false,
      applied: false,
    });
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: (j3 as any)._id,
      matchScore: 75, verdict: 'Good', reasoning: 'Test',
      freshness: Freshness.FRESH, clicked: false, skipped: false,
      applied: null,
    });

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((appliedMatch as any)._id.toString());
  });

  // ── 3. WINDOW INDEPENDENCE ──────────────────────────────────────────────────

  it('returns applied records older than 15 days [contract: window independence]', async () => {
    const job = await createJobListing();
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 3600 * 1000);

    // Insert directly via the collection to bypass Mongoose timestamps plugin
    // and force an old createdAt — the only reliable way to back-date a doc.
    await MatchRecord.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: ownerUserId,
      jobId: (job as any)._id,
      matchScore: 75,
      verdict: 'Good match',
      reasoning: 'Old record — should appear in tracker',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: true,
      appliedAt: twentyDaysAgo,
      createdAt: twentyDaysAgo,
      updatedAt: twentyDaysAgo,
    });

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);

    // At least one returned item must have an appliedAt older than 14 days
    const foundOld = res.body.some((item: any) => {
      if (!item.appliedAt) return false;
      const daysElapsed =
        (Date.now() - new Date(item.appliedAt).getTime()) / (24 * 3600 * 1000);
      return daysElapsed > 14;
    });
    expect(foundOld).toBe(true);
  });

  // ── 4. SCORE INDEPENDENCE ───────────────────────────────────────────────────

  it('returns applied records with matchScore below user minScore [contract: score independence]', async () => {
    // Create user with a high minScore so a score-filtering implementation would exclude the match.
    await createUser(ownerUserId, 70);
    const job = await createJobListing();
    await createAppliedMatch(ownerUserId, (job as any)._id, { matchScore: 20 });

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].matchScore).toBe(20);
  });

  // ── 5. NULL-JOB RETENTION ───────────────────────────────────────────────────

  it('returns applied records whose JobListing was deleted, with job: null [contract: null-job retention]', async () => {
    const orphanJobId = new mongoose.Types.ObjectId();

    await MatchRecord.create({
      userId: ownerUserId,
      jobId: orphanJobId,
      matchScore: 80,
      verdict: 'Good',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: true,
      appliedAt: new Date(),
    });

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // Record must be present (not silently dropped) and job must be null (not missing entirely).
    expect(res.body[0].job).toBeNull();
  });

  it('null-job record is returned alongside a record with an existing job', async () => {
    const existingJob = await createJobListing();
    const orphanJobId = new mongoose.Types.ObjectId();

    await createAppliedMatch(ownerUserId, (existingJob as any)._id);
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: orphanJobId,
      matchScore: 65,
      verdict: 'Ok',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: true,
      appliedAt: new Date(),
    });

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const withJob = res.body.find((r: any) => r.job !== null);
    const withoutJob = res.body.find((r: any) => r.job === null);
    expect(withJob).toBeDefined();
    expect(withoutJob).toBeDefined();
  });

  // ── 6. Job field populated when listing exists ──────────────────────────────

  it('populates the job field with JobListing data when the listing exists', async () => {
    const job = await createJobListing();
    await createAppliedMatch(ownerUserId, (job as any)._id);

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].job).not.toBeNull();
    expect(res.body[0].job.title).toBe('Software Engineer');
    expect(res.body[0].job.company).toBe('TestCo');
  });

  // ── 7. CROSS-USER ISOLATION ─────────────────────────────────────────────────

  it("does NOT return another user's applied records [contract: cross-user isolation]", async () => {
    const jobA = await createJobListing();
    const jobB = await createJobListing();

    const matchA = await createAppliedMatch(ownerUserId, (jobA as any)._id);
    await createAppliedMatch(otherUserId, (jobB as any)._id);

    // Request as ownerUserId
    currentUserId = ownerUserId;
    const res = await request(testApp).get('/api/matches/tracker');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((matchA as any)._id.toString());
  });

  it("user B cannot see user A's applied records [contract: isolation is symmetric]", async () => {
    const jobA = await createJobListing();
    const jobB = await createJobListing();

    await createAppliedMatch(ownerUserId, (jobA as any)._id);
    const matchB = await createAppliedMatch(otherUserId, (jobB as any)._id);

    // Request as otherUserId
    currentUserId = otherUserId;
    const res = await request(testApp).get('/api/matches/tracker');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((matchB as any)._id.toString());
  });

  it('user with no records sees empty array even when other users have applied records', async () => {
    const job = await createJobListing();
    await createAppliedMatch(otherUserId, (job as any)._id);

    // ownerUserId has no records; only other user does
    currentUserId = ownerUserId;
    const res = await request(testApp).get('/api/matches/tracker');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("the implementer's smoke test exercises only a single injected user; this test proves isolation with real documents for both users", async () => {
    // Three users: owner, other A, other B.
    const thirdUserId = new mongoose.Types.ObjectId();
    const j1 = await createJobListing();
    const j2 = await createJobListing();
    const j3 = await createJobListing();

    const matchOwner = await createAppliedMatch(ownerUserId, (j1 as any)._id);
    await createAppliedMatch(otherUserId, (j2 as any)._id);
    await createAppliedMatch(thirdUserId, (j3 as any)._id);

    // Request as ownerUserId — must see EXACTLY 1 record
    currentUserId = ownerUserId;
    const res = await request(testApp).get('/api/matches/tracker');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((matchOwner as any)._id.toString());
  });
});
