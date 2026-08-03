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

let ownerUserId: mongoose.Types.ObjectId;
let otherUserId: mongoose.Types.ObjectId;

beforeEach(() => {
  ownerUserId = new mongoose.Types.ObjectId();
  otherUserId = new mongoose.Types.ObjectId();
  currentUserId = ownerUserId;
});

async function createJob() {
  return JobListing.create({
    title: 'Software Engineer',
    company: 'TestCo',
    location: ['Remote'],
    source: 'test',
    description: 'A test job',
    url: 'https://example.com/job',
    postedDate: new Date(),
  });
}

async function createMatch(
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
    applied: false,
    ...overrides,
  });
}

let emailCounter = 0;
async function createUser(userId: mongoose.Types.ObjectId) {
  emailCounter++;
  return User.create({
    _id: userId,
    name: 'Test User',
    email: `unskip-test-${emailCounter}-${userId.toString()}@example.com`,
    password: 'hashed',
    isVerified: true,
    resume: { summary: 'Engineer', skills: ['JS'], experience: [], education: [] },
    preferences: {
      matchingEnabled: true,
      remoteOnly: false,
      minSalary: 0,
      location: [],
      jobTypes: [],
      industries: [],
      minScore: 30,
    },
    walletBalance: 1.0,
    skippedJobs: [],
  });
}

// ── POST /api/matches/unskip ──────────────────────────────────────────────────

describe('POST /api/matches/unskip', () => {
  it('clears skipped=false and skipReason on a user-skipped match', async () => {
    await createUser(ownerUserId);
    const job = await createJob();
    const match = await createMatch(ownerUserId, job._id as mongoose.Types.ObjectId, {
      skipped: true,
      skipReason: { category: 'salary', details: 'too low' },
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(200);

    const updated = await MatchRecord.findById(match._id);
    expect(updated!.skipped).toBe(false);
    expect(updated!.skipReason).toBeUndefined();
  });

  it('returns 403 when the match belongs to another user', async () => {
    await createUser(ownerUserId);
    await createUser(otherUserId);
    const job = await createJob();
    const match = await createMatch(otherUserId, job._id as mongoose.Types.ObjectId, {
      skipped: true,
      skipReason: { category: 'salary' },
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(403);
  });

  it('returns 400 for an auto-skipped match (skipped=true, no skipReason)', async () => {
    await createUser(ownerUserId);
    const job = await createJob();
    const match = await createMatch(ownerUserId, job._id as mongoose.Types.ObjectId, {
      skipped: true,
      // No skipReason — auto-skip
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a user-skipped/i);
  });

  it('returns 200 idempotently when match is already unskipped', async () => {
    await createUser(ownerUserId);
    const job = await createJob();
    const match = await createMatch(ownerUserId, job._id as mongoose.Types.ObjectId, {
      skipped: false,
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(200);
  });

  it('returns 400 for a production-shaped auto-skip (verdict:"skipped" + real category)', async () => {
    // The nightly matcher writes auto-skips with verdict:"skipped", matchScore:0 AND a real
    // skipReason.category. The old guard (category check only) would incorrectly allow these.
    await createUser(ownerUserId);
    const job = await createJob();
    const match = await createMatch(ownerUserId, job._id as mongoose.Types.ObjectId, {
      skipped: true,
      verdict: 'skipped',
      matchScore: 0,
      skipReason: { category: 'relevance' },
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a user-skipped/i);
  });

  it('does not mutate a production-shaped auto-skip after 400', async () => {
    await createUser(ownerUserId);
    const job = await createJob();
    const match = await createMatch(ownerUserId, job._id as mongoose.Types.ObjectId, {
      skipped: true,
      verdict: 'skipped',
      matchScore: 0,
      skipReason: { category: 'salary' },
    });

    await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    const reloaded = await MatchRecord.findById(match._id);
    expect(reloaded!.skipped).toBe(true);
    expect(reloaded!.skipReason?.category).toBe('salary');
  });

  it('unskips a user-skip with "salary" category when verdict is real (overlap case)', async () => {
    // "salary" is shared by auto-skips (verdict:"skipped") and user-skips (real verdict).
    // A real verdict must be treated as a user-skip regardless of category.
    await createUser(ownerUserId);
    const job = await createJob();
    const match = await createMatch(ownerUserId, job._id as mongoose.Types.ObjectId, {
      skipped: true,
      verdict: 'Strong match',
      matchScore: 80,
      skipReason: { category: 'salary', details: 'Not enough' },
    });

    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(200);

    const reloaded = await MatchRecord.findById(match._id);
    expect(reloaded!.skipped).toBe(false);
    expect(reloaded!.skipReason).toBeUndefined();
  });

  it('returns 400 for missing matchId', async () => {
    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid ObjectId', async () => {
    const res = await request(testApp)
      .post('/api/matches/unskip')
      .send({ matchId: 'not-an-object-id' });

    expect(res.status).toBe(400);
  });
});

// ── GET /api/matches/skipped ──────────────────────────────────────────────────

describe('GET /api/matches/skipped', () => {
  it('returns only user-skipped rows (excludes auto-skipped)', async () => {
    await createUser(ownerUserId);
    const job1 = await createJob();
    const job2 = await createJob();
    const job3 = await createJob();

    // User-skipped: has skipReason
    const userSkipped = await createMatch(ownerUserId, job1._id as mongoose.Types.ObjectId, {
      skipped: true,
      skipReason: { category: 'salary' },
    });

    // Auto-skipped: no skipReason
    await createMatch(ownerUserId, job2._id as mongoose.Types.ObjectId, {
      skipped: true,
      // No skipReason
    });

    // Not skipped at all
    await createMatch(ownerUserId, job3._id as mongoose.Types.ObjectId, {
      skipped: false,
    });

    const res = await request(testApp).get('/api/matches/skipped');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((userSkipped._id as mongoose.Types.ObjectId).toString());
  });

  it('excludes production-shaped auto-skips (verdict:"skipped" + real category) from skipped list', async () => {
    // Old query: checked only skipReason.category existence — passed auto-skips through.
    // New query: also requires verdict !== "skipped".
    await createUser(ownerUserId);
    const job1 = await createJob();
    const job2 = await createJob();

    // Production auto-skip: has category but verdict:"skipped"
    await createMatch(ownerUserId, job1._id as mongoose.Types.ObjectId, {
      skipped: true,
      verdict: 'skipped',
      matchScore: 0,
      skipReason: { category: 'relevance' },
    });

    // User-skip: has category and real verdict
    const userSkipped = await createMatch(ownerUserId, job2._id as mongoose.Types.ObjectId, {
      skipped: true,
      verdict: 'Strong match',
      matchScore: 80,
      skipReason: { category: 'salary' },
    });

    const res = await request(testApp).get('/api/matches/skipped');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]._id.toString()).toBe((userSkipped._id as mongoose.Types.ObjectId).toString());
  });

  it('includes the job object on each result', async () => {
    await createUser(ownerUserId);
    const job = await createJob();
    await createMatch(ownerUserId, job._id as mongoose.Types.ObjectId, {
      skipped: true,
      skipReason: { category: 'location' },
    });

    const res = await request(testApp).get('/api/matches/skipped');

    expect(res.status).toBe(200);
    expect(res.body[0].job).not.toBeNull();
    expect(res.body[0].job.title).toBe('Software Engineer');
  });

  it('returns an empty array when no user-skipped matches exist', async () => {
    await createUser(ownerUserId);
    const res = await request(testApp).get('/api/matches/skipped');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('does not include matches from other users', async () => {
    await createUser(ownerUserId);
    await createUser(otherUserId);
    const job = await createJob();

    await createMatch(otherUserId, job._id as mongoose.Types.ObjectId, {
      skipped: true,
      skipReason: { category: 'salary' },
    });

    currentUserId = ownerUserId;
    const res = await request(testApp).get('/api/matches/skipped');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});
