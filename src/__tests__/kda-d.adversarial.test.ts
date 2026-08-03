/**
 * ADVERSARIAL TEST — kda-D (onlyjobs-oxm / kda-D)
 * "undo skip" feature: POST /api/matches/unskip + GET /api/matches/skipped
 *
 * Assume the implementation is subtly WRONG; write tests that EXPOSE bugs.
 * Report pass/fail — failures are FINDINGS, not fixes.
 * Do NOT modify production code, do NOT weaken tests.
 *
 * FORBIDDEN FILES (NOT opened):
 *   backend/src/controllers/matchController.ts
 *   backend/src/__tests__/unskip.test.ts
 *   frontend/src/pages/today.tsx
 *   frontend/src/pages/dashboard/index.tsx
 *   frontend/src/__tests__/kda-d.smoke.test.tsx
 *
 * Harness pattern derived from matchOwnership.test.ts and tracker.adversarial.test.ts.
 * MongoMemoryServer provided globally by src/__tests__/setup.ts.
 *
 * CONTRACT = oracle. Every expected value traces to the kda-D spec.
 * DISCLOSURE: see bottom of file.
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
import User from '../models/User';
import matchRoutes from '../routes/matchRoutes';

// ── Test app ──────────────────────────────────────────────────────────────────
// currentUserId is mutable so individual tests can switch identity to test
// cross-user isolation (same pattern as matchOwnership.test.ts).
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

async function createUserSkippedMatch(
  userId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {}
) {
  return MatchRecord.create({
    userId,
    jobId: new mongoose.Types.ObjectId(),
    matchScore: 42,
    verdict: 'Good match',
    reasoning: 'Test reasoning',
    freshness: Freshness.FRESH,
    clicked: false,
    skipped: true,
    skipReason: { category: 'salary', details: 'Too low' },
    applied: null,
    ...overrides,
  });
}

async function createUserWithPrefs(
  userId: mongoose.Types.ObjectId,
  learnedPreferences?: { insights: string; lastUpdated: Date; feedbackCount: number },
  minScore = 30
) {
  return User.create({
    _id: userId,
    name: 'Test User',
    email: `kda-d-adv-${userId.toString()}@example.com`,
    password: 'hashed',
    resume: { skills: [], experience: [], education: [], summary: '' },
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
    learnedPreferences,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/matches/unskip
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/matches/unskip — input validation', () => {

  it('1a: missing matchId body → 400 [contract: matchId required]', async () => {
    const res = await request(testApp).post('/api/matches/unskip').send({});
    // FINDING if 500: missing body crashes the handler rather than validating
    expect(res.status).toBe(400);
  });

  it('1b: matchId=null → 400 [contract: null is not a valid matchId]', async () => {
    const res = await request(testApp).post('/api/matches/unskip').send({ matchId: null });
    expect(res.status).toBe(400);
  });

  it('1c: matchId="" (empty string) → 400 [contract: empty string is not a valid matchId]', async () => {
    const res = await request(testApp).post('/api/matches/unskip').send({ matchId: '' });
    expect(res.status).toBe(400);
  });

  it('1d: matchId="abc" (clearly invalid ObjectId) → 400, NOT 500 [contract: no Mongoose cast error leak]', async () => {
    // CRITICAL FINDING if 500: Mongoose CastError is not caught — internal error leaks to client.
    const res = await request(testApp).post('/api/matches/unskip').send({ matchId: 'abc' });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('1e: matchId="not-a-valid-objectid-at-all-xyz" (long invalid string) → 400, not 500', async () => {
    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: 'not-a-valid-objectid-at-all-xyz' });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('1f: matchId=123 (number, not string) → 400 [contract: type must be string/ObjectId]', async () => {
    const res = await request(testApp).post('/api/matches/unskip').send({ matchId: 123 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/matches/unskip — not found', () => {

  it('2a: valid ObjectId format, no such record → 404 [contract: record not found]', async () => {
    const nonExistentId = new mongoose.Types.ObjectId();
    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: nonExistentId.toString() });
    // FINDING if 200: endpoint silently no-ops on a non-existent record instead of 404
    // FINDING if 500: query throws rather than returning null
    expect(res.status).toBe(404);
  });
});

describe('POST /api/matches/unskip — authorization', () => {

  it('3a: record owned by a DIFFERENT user → 403 [contract: cross-user forbidden]', async () => {
    const match = await createUserSkippedMatch(otherUserId);

    // Request as ownerUserId (not the record owner)
    currentUserId = ownerUserId;
    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    // FINDING if 200: endpoint does not enforce ownership
    // FINDING if 404: endpoint leaks existence info via wrong status
    expect(res.status).toBe(403);
  });

  it('3b: 403 response must NOT mutate the other user\'s record [contract: 403 is non-destructive]', async () => {
    const match = await createUserSkippedMatch(otherUserId, {
      skipReason: { category: 'company_type', details: 'Not interested' },
    });

    currentUserId = ownerUserId;
    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    // Re-fetch and assert state is unchanged
    const reloaded = await MatchRecord.findById(match._id);
    expect(reloaded).not.toBeNull();
    // CRITICAL FINDING if false: the 403 path still mutated the record
    expect(reloaded!.skipped).toBe(true);
    expect(reloaded!.skipReason?.category).toBe('company_type');
  });
});

describe('POST /api/matches/unskip — happy path mutation', () => {

  it('4a: user-skipped own record → 200 [contract: successful unskip]', async () => {
    const match = await createUserSkippedMatch(ownerUserId);
    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });
    expect(res.status).toBe(200);
  });

  it('4b: after 200, re-fetch shows skipped===false [contract: mutation persisted to DB]', async () => {
    const match = await createUserSkippedMatch(ownerUserId);
    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    const reloaded = await MatchRecord.findById(match._id);
    expect(reloaded).not.toBeNull();
    // CRITICAL FINDING if true: the DB write did not happen (or was immediately undone)
    expect(reloaded!.skipped).toBe(false);
  });

  it('4c: after 200, re-fetch shows skipReason absent [contract: skipReason cleared on unskip]', async () => {
    const match = await createUserSkippedMatch(ownerUserId, {
      skipReason: { category: 'role_mismatch', details: 'Wrong seniority', analyzedAt: new Date() },
    });
    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    const reloaded = await MatchRecord.findById(match._id);
    // FINDING if defined: skipReason was not cleared — the skip reason leaks into unskipped state
    expect(reloaded!.skipReason).toBeUndefined();
  });

  it('4d: unskip with skipReason.category="other" also clears it [not just specific categories]', async () => {
    const match = await createUserSkippedMatch(ownerUserId, {
      skipReason: { category: 'other', details: 'Custom reason' },
    });
    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    const reloaded = await MatchRecord.findById(match._id);
    expect(reloaded!.skipped).toBe(false);
    expect(reloaded!.skipReason).toBeUndefined();
  });
});

describe('POST /api/matches/unskip — field stability', () => {

  it('5a: unskip must not alter clicked, applied, appliedAt, matchScore, verdict, reasoning', async () => {
    const appliedAt = new Date('2026-03-15T10:00:00.000Z');
    const match = await createUserSkippedMatch(ownerUserId, {
      clicked: true,
      applied: true,
      appliedAt,
      matchScore: 77,
      verdict: 'Strong match',
      reasoning: 'Detailed reasoning text that should survive unskip',
    });

    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    const reloaded = await MatchRecord.findById(match._id);
    expect(reloaded).not.toBeNull();

    // FINDING if any of these changed: unskip is touching fields outside its contract
    expect(reloaded!.clicked).toBe(true);
    expect(reloaded!.applied).toBe(true);
    expect(reloaded!.appliedAt?.toISOString()).toBe(appliedAt.toISOString());
    expect(reloaded!.matchScore).toBe(77);
    expect(reloaded!.verdict).toBe('Strong match');
    expect(reloaded!.reasoning).toBe('Detailed reasoning text that should survive unskip');
  });

  it('5b: unskip must not alter scoreSamples / scoreAggregation fields', async () => {
    const match = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 65,
      verdict: 'Good',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'location' },
      applied: null,
      scoreSamples: [60, 65, 70],
      scoreSampleCount: 3,
      scoreAggregation: 'median_near_threshold',
    });

    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    const reloaded = await MatchRecord.findById(match._id);
    expect(reloaded!.scoreSamples).toEqual([60, 65, 70]);
    expect(reloaded!.scoreSampleCount).toBe(3);
    expect(reloaded!.scoreAggregation).toBe('median_near_threshold');
  });
});

// ── AUTO-SKIP GUARD — highest-value assertion ─────────────────────────────────
// Auto-skipped records (skipped=true, skipReason absent) must NOT be unskipped.
// Unskipping one would resurface a system-filtered job that the nightly matcher
// deliberately excluded — silently corrupting the user's match feed.

describe('POST /api/matches/unskip — auto-skip guard (CRITICAL)', () => {

  it('6a: auto-skip (skipped=true, NO skipReason) → 400 [contract: auto-skip guard]', async () => {
    const match = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 25,
      verdict: 'Poor match',
      reasoning: 'Auto-filtered by nightly matcher',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      // skipReason deliberately absent — this is how nightly matching writes auto-skips
      applied: null,
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    // CRITICAL FINDING if 200: auto-skipped record was unskipped, resurfacing a system-filtered job
    expect(res.status).toBe(400);
  });

  it('6b: auto-skip record NOT mutated after 400 [contract: guard is non-destructive]', async () => {
    const match = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 25,
      verdict: 'Poor match',
      reasoning: 'Auto-filtered',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      // No skipReason
      applied: null,
    });

    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    const reloaded = await MatchRecord.findById(match._id);
    expect(reloaded).not.toBeNull();
    // FINDING if false: the guard returned 400 but still mutated skipped=false
    expect(reloaded!.skipped).toBe(true);
    // skipReason must remain absent (guard must not accidentally ADD one)
    expect(reloaded!.skipReason).toBeUndefined();
  });

  it('6c: skipReason={} (empty object without category) is treated as auto-skip → 400', async () => {
    // skipReason.category is required per schema — if the stored doc somehow has
    // skipReason set but category is absent or falsy, the guard must still reject.
    // We insert directly via collection to bypass Mongoose validation.
    const matchId = new mongoose.Types.ObjectId();
    await MatchRecord.collection.insertOne({
      _id: matchId,
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 30,
      verdict: 'OK',
      reasoning: 'Corrupt record — skipReason without category',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: {}, // no category field
      applied: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: matchId.toString() });

    // FINDING if 200: the guard checks skipReason presence but not category presence
    // (an {} passes truthiness check but has no category — effectively an auto-skip)
    expect(res.status).toBe(400);
  });
});

// ── PRODUCTION-SHAPED AUTO-SKIP GUARD ────────────────────────────────────────
// Real auto-skips from the nightly matcher carry verdict:"skipped" + matchScore:0
// AND a real skipReason.category. The old guard (category check only) passes these.

describe('POST /api/matches/unskip — production-shaped auto-skip guard (CRITICAL)', () => {

  const AUTO_SKIP_CATEGORIES = ['relevance', 'location', 'salary', 'other'] as const;

  for (const category of AUTO_SKIP_CATEGORIES) {
    it(`PA-1-${category}: auto-skip (verdict:"skipped", matchScore:0, category="${category}") → 400`, async () => {
      const match = await MatchRecord.create({
        userId: ownerUserId,
        jobId: new mongoose.Types.ObjectId(),
        matchScore: 0,
        verdict: 'skipped',
        reasoning: 'Auto-filtered by nightly matcher',
        freshness: Freshness.FRESH,
        clicked: false,
        skipped: true,
        skipReason: { category },
        applied: null,
      });

      const res = await request(testApp)
        .post('/api/matches/unskip')
        .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

      // CRITICAL FINDING if 200: production-shaped auto-skip was unskipped — old guard only
      // checked category presence and passed this case, resurfacing a system-filtered job.
      expect(res.status).toBe(400);
    });

    it(`PA-2-${category}: auto-skip (verdict:"skipped", category="${category}") NOT mutated after 400`, async () => {
      const match = await MatchRecord.create({
        userId: ownerUserId,
        jobId: new mongoose.Types.ObjectId(),
        matchScore: 0,
        verdict: 'skipped',
        reasoning: 'Auto-filtered',
        freshness: Freshness.FRESH,
        clicked: false,
        skipped: true,
        skipReason: { category },
        applied: null,
      });

      await request(testApp)
        .post('/api/matches/unskip')
        .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

      const reloaded = await MatchRecord.findById(match._id);
      expect(reloaded).not.toBeNull();
      // CRITICAL FINDING if false: guard returned 400 but still mutated the record
      expect(reloaded!.skipped).toBe(true);
      expect(reloaded!.skipReason?.category).toBe(category);
    });
  }

  it('PA-3 (OVERLAP): user-skip with salary category + real verdict → 200, skipped=false [discriminator is verdict-based]', async () => {
    // A row with skipReason.category:"salary" but a REAL verdict must be treated as a
    // user-skip. The discriminator is verdict, not category.
    const match = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 80,
      verdict: 'Strong match',
      reasoning: 'AI scored this highly',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'salary', details: 'Offered too low' },
      applied: null,
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    // CRITICAL FINDING if 400: category-based discriminator incorrectly rejects a real user-skip
    // whose category happens to match an auto-skip category.
    expect(res.status).toBe(200);

    const reloaded = await MatchRecord.findById(match._id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.skipped).toBe(false);
    expect(reloaded!.skipReason).toBeUndefined();
  });
});

describe('POST /api/matches/unskip — idempotence', () => {

  it('7a: record already skipped=false → 200 no-op [contract: idempotent unskip]', async () => {
    const match = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 60,
      verdict: 'Good',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: null,
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    // FINDING if 400/404/500: idempotent call errors rather than no-op
    expect(res.status).toBe(200);
  });

  it('7b: calling unskip twice on the same record → both return 200 [idempotence is durable]', async () => {
    const match = await createUserSkippedMatch(ownerUserId);
    const matchId = (match._id as mongoose.Types.ObjectId).toString();

    const res1 = await request(testApp).post('/api/matches/unskip').send({ matchId });
    const res2 = await request(testApp).post('/api/matches/unskip').send({ matchId });

    expect(res1.status).toBe(200);
    // FINDING if 400: the second call fails because the record is now unskipped
    // (an impl that checks skipped===true before proceeding would fail here)
    expect(res2.status).toBe(200);
  });
});

describe('POST /api/matches/unskip — preference-learning non-mutation (CRITICAL)', () => {
  // Per the architectural decision: unskip MUST NOT call preferenceLearningService.
  // If it did, User.learnedPreferences would change after the unskip call.
  // We detect the observable side-effect, not the mechanism.

  it('8a: unskip does NOT change User.learnedPreferences [contract: no preference learning on unskip]', async () => {
    const frozenPrefs = {
      insights: 'Prefers remote senior roles with salary > 120k in fintech',
      lastUpdated: new Date('2026-06-15T00:00:00.000Z'),
      feedbackCount: 7,
    };

    await createUserWithPrefs(ownerUserId, frozenPrefs);
    const match = await createUserSkippedMatch(ownerUserId);

    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    const reloadedUser = await User.findById(ownerUserId);
    expect(reloadedUser).not.toBeNull();

    // CRITICAL FINDING if any of these differ: unskip triggered preference learning
    expect(reloadedUser!.learnedPreferences?.insights).toBe(frozenPrefs.insights);
    expect(reloadedUser!.learnedPreferences?.feedbackCount).toBe(frozenPrefs.feedbackCount);
    expect(reloadedUser!.learnedPreferences?.lastUpdated.toISOString()).toBe(
      frozenPrefs.lastUpdated.toISOString()
    );
  });

  it('8b: unskip does NOT create learnedPreferences when user had none [contract: no preference learning]', async () => {
    await createUserWithPrefs(ownerUserId); // no learnedPreferences
    const match = await createUserSkippedMatch(ownerUserId);

    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    const reloadedUser = await User.findById(ownerUserId);
    expect(reloadedUser).not.toBeNull();
    // FINDING if defined: unskip created learnedPreferences out of thin air
    expect(reloadedUser!.learnedPreferences).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/matches/skipped
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/matches/skipped — filter correctness', () => {

  it('S-1a: empty DB → 200 with empty array', async () => {
    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('S-1b: non-skipped record (skipped=false) is EXCLUDED from skipped list', async () => {
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 70,
      verdict: 'Good',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: null,
    });

    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 1: non-skipped record leaked into the skipped list
    expect(res.body).toHaveLength(0);
  });

  it('S-1c: auto-skipped (skipped=true, NO skipReason) is EXCLUDED [critical filter]', async () => {
    // This is the key distinction between user-skipped and auto-skipped.
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 20,
      verdict: 'Poor',
      reasoning: 'System auto-filtered',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      // No skipReason — auto-skip
      applied: null,
    });

    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // CRITICAL FINDING if 1: auto-skipped row exposed to the user via the skipped list
    expect(res.body).toHaveLength(0);
  });

  it('S-1d: user-skipped (skipped=true + skipReason.category) IS included', async () => {
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 55,
      verdict: 'OK',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'salary' },
      applied: null,
    });

    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 0: user-skipped record was not returned
    expect(res.body).toHaveLength(1);
    expect(res.body[0].skipReason.category).toBe('salary');
  });

  it('S-1e: mixed set — only user-skipped rows returned, auto-skipped and non-skipped excluded', async () => {
    // (a) user-skipped 1
    const us1 = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 55,
      verdict: 'OK',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'salary' },
      applied: null,
    });

    // (b) user-skipped 2 (different category)
    const us2 = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 62,
      verdict: 'OK',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'location', details: 'Too far' },
      applied: null,
    });

    // (c) auto-skipped — must NOT appear
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 20,
      verdict: 'Poor',
      reasoning: 'Auto',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      applied: null,
    });

    // (d) not-skipped — must NOT appear
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 75,
      verdict: 'Good',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: false,
      applied: null,
    });

    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);

    // FINDING if 4: all records returned regardless of skip type
    // FINDING if 1: only one of the two user-skipped rows returned
    // FINDING if 3: auto-skipped leaked through
    expect(res.body).toHaveLength(2);

    const returnedIds = res.body.map((r: any) => r._id.toString());
    expect(returnedIds).toContain((us1._id as mongoose.Types.ObjectId).toString());
    expect(returnedIds).toContain((us2._id as mongoose.Types.ObjectId).toString());
  });
});

// ── PRODUCTION-SHAPED AUTO-SKIP EXCLUSION (GET /skipped) ─────────────────────
// Each of the four nightly-matcher auto-skip categories must be excluded when
// verdict:"skipped". The old query checked only category presence.

describe('GET /api/matches/skipped — production-shaped auto-skip exclusion (CRITICAL)', () => {

  const AUTO_SKIP_CATEGORIES = ['relevance', 'location', 'salary', 'other'] as const;

  for (const category of AUTO_SKIP_CATEGORIES) {
    it(`AS-1-${category}: auto-skip (verdict:"skipped", category="${category}") EXCLUDED`, async () => {
      await MatchRecord.create({
        userId: ownerUserId,
        jobId: new mongoose.Types.ObjectId(),
        matchScore: 0,
        verdict: 'skipped',
        reasoning: 'Auto-filtered by nightly matcher',
        freshness: Freshness.FRESH,
        clicked: false,
        skipped: true,
        skipReason: { category },
        applied: null,
      });

      const res = await request(testApp).get('/api/matches/skipped');
      expect(res.status).toBe(200);
      // CRITICAL FINDING if 1: production auto-skip leaked into the skipped view —
      // the old query only checked category existence and passed this case.
      expect(res.body).toHaveLength(0);
    });
  }

  it('AS-2 (OVERLAP): user-skip with salary category + real verdict INCLUDED [verdict is the discriminator]', async () => {
    // "salary" is used by both auto-skips (verdict:"skipped") and user-skips (real verdict).
    // Only verdict distinguishes them.
    const match = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 80,
      verdict: 'Strong match',
      reasoning: 'AI thinks this is strong',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'salary', details: 'User chose to skip anyway' },
      applied: null,
    });

    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 0: user-skip incorrectly excluded — discriminator is category-based not verdict-based
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((match._id as mongoose.Types.ObjectId).toString());
  });

  it('AS-3: same category, auto-skip excluded + user-skip included — only one row returned', async () => {
    // Auto-skip: salary category, verdict:"skipped"
    await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 0,
      verdict: 'skipped',
      reasoning: 'Auto-filtered',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'salary' },
      applied: null,
    });

    // User-skip: same category, real verdict
    const userSkip = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 65,
      verdict: 'Good match',
      reasoning: 'AI liked it',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'salary', details: 'Not enough' },
      applied: null,
    });

    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 2: auto-skip leaked through alongside the user-skip
    // FINDING if 0: user-skip was incorrectly excluded along with the auto-skip
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((userSkip._id as mongoose.Types.ObjectId).toString());
  });
});

describe('GET /api/matches/skipped — cross-user isolation', () => {

  it('S-2a: user A GET must not return user B\'s skipped rows', async () => {
    const ownerSkipped = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 50,
      verdict: 'OK',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'role_mismatch' },
      applied: null,
    });

    // User B's skipped row — must NOT appear in user A's response
    await MatchRecord.create({
      userId: otherUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 55,
      verdict: 'OK',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'salary' },
      applied: null,
    });

    currentUserId = ownerUserId;
    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 2: user B's row leaked into user A's skipped list
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((ownerSkipped._id as mongoose.Types.ObjectId).toString());
  });

  it('S-2b: user B sees only their own rows when user A has more [symmetric isolation]', async () => {
    // User A: 3 user-skipped rows
    for (let i = 0; i < 3; i++) {
      await MatchRecord.create({
        userId: ownerUserId,
        jobId: new mongoose.Types.ObjectId(),
        matchScore: 50 + i,
        verdict: 'OK',
        reasoning: 'Test',
        freshness: Freshness.FRESH,
        clicked: false,
        skipped: true,
        skipReason: { category: 'salary' },
        applied: null,
      });
    }

    // User B: 1 user-skipped row
    const otherSkipped = await MatchRecord.create({
      userId: otherUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 55,
      verdict: 'OK',
      reasoning: 'Test',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'other' },
      applied: null,
    });

    currentUserId = otherUserId;
    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 4: user A's rows leaked into user B's response
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((otherSkipped._id as mongoose.Types.ObjectId).toString());
  });

  it('S-2c: user with no records sees empty array even when another user has many skipped rows', async () => {
    // Populate another user with skipped rows
    for (let i = 0; i < 5; i++) {
      await MatchRecord.create({
        userId: otherUserId,
        jobId: new mongoose.Types.ObjectId(),
        matchScore: 40 + i,
        verdict: 'OK',
        reasoning: 'Test',
        freshness: Freshness.FRESH,
        clicked: false,
        skipped: true,
        skipReason: { category: 'company_type' },
        applied: null,
      });
    }

    currentUserId = ownerUserId; // owner has nothing
    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 5: no userId filter applied at all
    expect(res.body).toHaveLength(0);
  });
});

describe('GET /api/matches/skipped — minScore/window independence', () => {
  // The skipped endpoint must NOT apply the /matches 15-day window or minScore filter.
  // User-skipped rows appear regardless of age or score — the user chose to skip them,
  // so they must be available to undo regardless of when or how well they scored.

  it('S-3a: low-score user-skipped row appears even when user.preferences.minScore is high', async () => {
    // Create user with minScore=70 — a score-filtering impl would drop this row
    await createUserWithPrefs(ownerUserId, undefined, 70);

    const lowScoreSkipped = await MatchRecord.create({
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 12,  // well below minScore=70
      verdict: 'Poor',
      reasoning: 'Low score but user explicitly skipped',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'job_inactive' },
      applied: null,
    });

    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 0: endpoint wrongly applied minScore filter to the skipped list
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((lowScoreSkipped._id as mongoose.Types.ObjectId).toString());
    expect(res.body[0].matchScore).toBe(12);
  });

  it('S-3b: user-skipped row with createdAt >15 days ago appears [window independence]', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 3600 * 1000);

    // Insert directly via collection to force old createdAt (bypasses Mongoose timestamps plugin)
    const matchId = new mongoose.Types.ObjectId();
    await MatchRecord.collection.insertOne({
      _id: matchId,
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 60,
      verdict: 'Good',
      reasoning: 'Old user-skipped record',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'salary' },
      applied: null,
      createdAt: twentyDaysAgo,
      updatedAt: twentyDaysAgo,
    });

    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 0: endpoint applied a 15-day window to the skipped list (wrong)
    expect(res.body.length).toBeGreaterThanOrEqual(1);

    const returnedIds = res.body.map((r: any) => r._id.toString());
    expect(returnedIds).toContain(matchId.toString());
  });

  it('S-3c: both old+low-score user-skipped rows appear (combined window+score independence)', async () => {
    await createUserWithPrefs(ownerUserId, undefined, 70);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const matchId = new mongoose.Types.ObjectId();
    await MatchRecord.collection.insertOne({
      _id: matchId,
      userId: ownerUserId,
      jobId: new mongoose.Types.ObjectId(),
      matchScore: 8,  // below minScore=70 AND old
      verdict: 'Very poor',
      reasoning: 'Old low-score user-skipped',
      freshness: Freshness.FRESH,
      clicked: false,
      skipped: true,
      skipReason: { category: 'other' },
      applied: null,
      createdAt: thirtyDaysAgo,
      updatedAt: thirtyDaysAgo,
    });

    const res = await request(testApp).get('/api/matches/skipped');
    expect(res.status).toBe(200);
    // FINDING if 0: either filter (minScore or window) excluded the row
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const ids = res.body.map((r: any) => r._id.toString());
    expect(ids).toContain(matchId.toString());
  });
});

describe('GET /api/matches/skipped + POST /api/matches/unskip — roundtrip integrity', () => {

  it('RT-1: unskipped record no longer appears in GET /skipped', async () => {
    const match = await createUserSkippedMatch(ownerUserId);

    // Confirm present before unskip
    const before = await request(testApp).get('/api/matches/skipped');
    expect(before.body).toHaveLength(1);

    // Unskip
    const unskipRes = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });
    expect(unskipRes.status).toBe(200);

    // Confirm absent after unskip
    const after = await request(testApp).get('/api/matches/skipped');
    // CRITICAL FINDING if 1: the record still appears after unskip — the GET filter is stale
    // or the unskip mutation did not propagate
    expect(after.body).toHaveLength(0);
  });

  it('RT-2: unskipping one of several skipped records removes only that one from GET /skipped', async () => {
    const m1 = await createUserSkippedMatch(ownerUserId, { skipReason: { category: 'salary' } });
    const m2 = await createUserSkippedMatch(ownerUserId, { skipReason: { category: 'location' } });
    const m3 = await createUserSkippedMatch(ownerUserId, { skipReason: { category: 'other' } });

    const before = await request(testApp).get('/api/matches/skipped');
    expect(before.body).toHaveLength(3);

    // Unskip only m2
    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (m2._id as mongoose.Types.ObjectId).toString() });

    const after = await request(testApp).get('/api/matches/skipped');
    // FINDING if 3: unskip had no effect on the list
    // FINDING if 1: unskip removed all rows instead of just m2
    expect(after.body).toHaveLength(2);

    const remainingIds = after.body.map((r: any) => r._id.toString());
    expect(remainingIds).toContain((m1._id as mongoose.Types.ObjectId).toString());
    expect(remainingIds).toContain((m3._id as mongoose.Types.ObjectId).toString());
    expect(remainingIds).not.toContain((m2._id as mongoose.Types.ObjectId).toString());
  });
});

/*
 * ══════════════════════════════════════════════════════════════════════════════
 * DISCLOSURE
 *
 * Files opened while writing this test (from the allowed list):
 *   backend/src/models/MatchRecord.ts          — IMatchRecord, RejectionReason, schema details
 *   backend/src/models/User.ts                 — LearnedPreferences interface, schema
 *   backend/src/routes/matchRoutes.ts          — confirmed POST /unskip, GET /skipped paths
 *   backend/src/__tests__/setup.ts             — MongoMemoryServer globalsetup pattern
 *   backend/src/__tests__/matchOwnership.test.ts  — harness pattern, middleware mock
 *   backend/src/__tests__/tracker.adversarial.test.ts  — extended harness, collection.insertOne pattern
 *
 * Files NOT opened (forbidden):
 *   backend/src/controllers/matchController.ts          ✓ not opened
 *   backend/src/__tests__/unskip.test.ts                ✓ not opened
 *   frontend/src/pages/today.tsx                        ✓ not opened
 *   frontend/src/pages/dashboard/index.tsx              ✓ not opened
 *   frontend/src/__tests__/kda-d.smoke.test.tsx         ✓ not opened
 *
 * Incidental disclosures:
 *   - matchRoutes.ts imports `unskipMatch` and `getSkipped` from matchController. Saw
 *     these function names in passing — no assertions derive from them.
 *   - MatchRecord schema: `skipReason` is `default: undefined` and `category` is required
 *     within the sub-document. This confirmed that absence of skipReason (not a falsy
 *     category) is the correct auto-skip distinction. Test 6c probes the edge case of
 *     {} without category to expose any check that tests truthiness of skipReason alone.
 *   - User schema: `learnedPreferences` is `default: undefined`. Tests 8a/8b reflect this.
 *
 * Untestable-without-reading findings:
 *   - Preference non-mutation (8a/8b): only the OBSERVABLE SIDE EFFECT (learnedPreferences
 *     changed) can be verified from outside. Whether unskip calls preferenceLearningService
 *     at all requires reading the controller. Filed as tests against observable state.
 *   - skipReason clear mechanism (4c): whether $unset or undefined-assign is used is
 *     invisible from outside. The test asserts DB state (toBeUndefined) which covers both.
 *   - Auto-skip guard implementation (6a): the guard could be checking skipReason truthiness,
 *     checking skipReason.category existence, or checking a separate field. Test 6c probes
 *     the case where skipReason exists as {} without category, which distinguishes these.
 * ══════════════════════════════════════════════════════════════════════════════
 */
