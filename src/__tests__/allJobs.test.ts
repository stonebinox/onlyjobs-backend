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
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import JobListing from '../models/JobListing';
import MatchRecord from '../models/MatchRecord';
import Transaction from '../models/Transaction';
import jobRoutes from '../routes/jobRoutes';
import { matchUserToJob } from '../services/matchingService';
import { Freshness } from '../models/MatchRecord';

const mockMatchUserToJob = matchUserToJob as jest.Mock;

// Mutable user ref — each test sets this before making a request
let currentUser: any = null;

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

// App without auth header — for 401 tests
const testAppNoAuth = express();
testAppNoAuth.use(express.json());
testAppNoAuth.use('/api/jobs', jobRoutes);
testAppNoAuth.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

const BASE_USER = {
  name: 'Test User',
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
  const user = await User.create({
    _id: userId,
    email: `test-${Date.now()}-${Math.random()}@example.com`,
    ...BASE_USER,
    ...overrides,
  });
  return user;
}

async function createJob(overrides: Record<string, any> = {}) {
  const postedDate = new Date();
  postedDate.setDate(postedDate.getDate() - 3); // 3 days old (within 15 days)
  return JobListing.create({
    title: 'Software Engineer',
    company: 'Acme Inc',
    location: ['Remote'],
    source: 'wellfound',
    description: 'Build great things',
    url: `https://example.com/job-${Date.now()}-${Math.random()}`,
    postedDate,
    scrapedDate: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  currentUser = null;
  mockMatchUserToJob.mockReset();
});

// ---------------------------------------------------------------------------
// GET /api/jobs — 401 without auth
// ---------------------------------------------------------------------------

describe('GET /api/jobs — 401 without auth', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(testAppNoAuth).get('/api/jobs');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs — 403 for unverified user
// ---------------------------------------------------------------------------

describe('GET /api/jobs — 403 for unverified user', () => {
  it('returns 403 when user is not verified', async () => {
    const user = await createUser({ isVerified: false });
    currentUser = user;

    const res = await request(testApp).get('/api/jobs');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not verified/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs — paginated jobs
// ---------------------------------------------------------------------------

describe('GET /api/jobs — paginated results', () => {
  it('returns paginated jobs for verified user (only last 15 days)', async () => {
    const user = await createUser();
    currentUser = user;

    // Recent job (within 15 days)
    await createJob();

    // Old job (older than 15 days) — should NOT appear
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 20);
    await createJob({ postedDate: oldDate });

    const res = await request(testApp).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.pages).toBe(1);
  });

  it('returns only jobs with non-empty descriptions', async () => {
    const user = await createUser();
    currentUser = user;

    await createJob({ description: 'Real description about this role' });
    await createJob({ description: 'Another real job description' });

    const res = await request(testApp).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs.length).toBe(2);
    res.body.jobs.forEach((j: any) => {
      expect(j.description).not.toBe('');
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs?source=wellfound — source filter
// ---------------------------------------------------------------------------

describe('GET /api/jobs — source filter', () => {
  it('returns only jobs matching the source filter', async () => {
    const user = await createUser();
    currentUser = user;

    await createJob({ source: 'wellfound' });
    await createJob({ source: 'linkedin' });

    const res = await request(testApp).get('/api/jobs?source=wellfound');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].source).toBe('wellfound');
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs — match hydration
// ---------------------------------------------------------------------------

describe('GET /api/jobs — match hydration', () => {
  it('includes match field when MatchRecord exists for user+job', async () => {
    const user = await createUser();
    currentUser = user;

    const job = await createJob();
    await MatchRecord.create({
      userId: user._id,
      jobId: job._id,
      matchScore: 85,
      verdict: 'Strong match',
      reasoning: 'Great fit',
      freshness: Freshness.FRESH,
    });

    const res = await request(testApp).get('/api/jobs');
    expect(res.status).toBe(200);
    const matched = res.body.jobs.find((j: any) => j._id === (job._id as mongoose.Types.ObjectId).toString());
    expect(matched).toBeDefined();
    expect(matched.match).not.toBeNull();
    expect(matched.match.matchScore).toBe(85);
    expect(matched.match.verdict).toBe('Strong match');
  });

  it('match field is null when no MatchRecord exists', async () => {
    const user = await createUser();
    currentUser = user;

    await createJob();

    const res = await request(testApp).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs[0].match).toBeNull();
  });

  it('only returns match records belonging to the requesting user', async () => {
    const user = await createUser();
    currentUser = user;

    const otherUserId = new mongoose.Types.ObjectId();
    const job = await createJob();

    // Match record for a different user
    await MatchRecord.create({
      userId: otherUserId,
      jobId: job._id,
      matchScore: 90,
      verdict: 'Strong match',
      reasoning: 'Fits well',
      freshness: Freshness.FRESH,
    });

    const res = await request(testApp).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs[0].match).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs — returns sources array
// ---------------------------------------------------------------------------

describe('GET /api/jobs — sources array', () => {
  it('returns distinct sources sorted alphabetically', async () => {
    const user = await createUser();
    currentUser = user;

    await createJob({ source: 'wellfound' });
    await createJob({ source: 'linkedin' });
    await createJob({ source: 'greenhouse' });

    const res = await request(testApp).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual(['greenhouse', 'linkedin', 'wellfound']);
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/match — 401 without auth
// ---------------------------------------------------------------------------

describe('POST /api/jobs/:jobId/match — 401 without auth', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(testAppNoAuth).post('/api/jobs/fakeid/match');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/match — gate checks
// ---------------------------------------------------------------------------

describe('POST /api/jobs/:jobId/match — 403 for unverified user', () => {
  it('returns 403 when user is not verified', async () => {
    const user = await createUser({ isVerified: false });
    currentUser = user;

    const job = await createJob();
    const res = await request(testApp).post(`/api/jobs/${job._id}/match`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not verified/i);
  });
});

describe('POST /api/jobs/:jobId/match — gates', () => {
  it('returns 400 when user has no resume', async () => {
    const user = await createUser({
      resume: {
        summary: '',
        skills: [],
        experience: [],
        education: [],
        certifications: [],
        languages: [],
        projects: [],
        achievements: [],
        volunteerExperience: [],
        interests: [],
      },
    });
    currentUser = user;

    const job = await createJob();
    const res = await request(testApp).post(`/api/jobs/${job._id}/match`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/upload your cv/i);
  });

  it('returns 400 when user has insufficient balance', async () => {
    const user = await createUser({ walletBalance: 0 });
    currentUser = user;

    const job = await createJob();
    const res = await request(testApp).post(`/api/jobs/${job._id}/match`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient balance/i);
  });

  it('returns 400 when match already exists', async () => {
    const user = await createUser();
    currentUser = user;

    const job = await createJob();
    await MatchRecord.create({
      userId: user._id,
      jobId: job._id,
      matchScore: 70,
      verdict: 'Mild match',
      reasoning: 'Decent fit',
      freshness: Freshness.FRESH,
    });

    const res = await request(testApp).post(`/api/jobs/${job._id}/match`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already matched/i);
  });

  it('returns 404 when job is older than 15 days', async () => {
    const user = await createUser();
    currentUser = user;

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 20);
    const job = await createJob({ postedDate: oldDate });

    const res = await request(testApp).post(`/api/jobs/${job._id}/match`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found or no longer available/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/match — success
// ---------------------------------------------------------------------------

describe('POST /api/jobs/:jobId/match — success', () => {
  it('deducts $0.05, creates MatchRecord and Transaction on success', async () => {
    const user = await createUser({ walletBalance: 1.0 });
    currentUser = user;

    const job = await createJob();

    mockMatchUserToJob.mockResolvedValue({
      matchScore: 80,
      verdict: 'Strong match',
      reasoning: 'Excellent fit',
      freshness: Freshness.FRESH,
    });

    const res = await request(testApp).post(`/api/jobs/${job._id}/match`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.match.matchScore).toBe(80);
    expect(res.body.match.verdict).toBe('Strong match');

    // Wallet was deducted
    const updatedUser = await User.findById(user._id);
    expect(updatedUser!.walletBalance).toBeCloseTo(0.95, 5);

    // MatchRecord created
    const matchRecord = await MatchRecord.findOne({ userId: user._id, jobId: job._id });
    expect(matchRecord).not.toBeNull();
    expect(matchRecord!.matchScore).toBe(80);

    // Transaction created
    const tx = await Transaction.findOne({ userId: user._id, type: 'debit' });
    expect(tx).not.toBeNull();
    expect(tx!.amount).toBe(0.05);
    expect(tx!.status).toBe('completed');
  });

  it('wallet is debited then reversed when MatchRecord.create throws duplicate-key error (atomicity)', async () => {
    const user = await createUser({ walletBalance: 1.0 });
    currentUser = user;

    const job = await createJob();

    mockMatchUserToJob.mockResolvedValue({
      matchScore: 80,
      verdict: 'Strong match',
      reasoning: 'Excellent fit',
      freshness: Freshness.FRESH,
    });

    // Simulate a duplicate-key error from MatchRecord.create
    const dupError = Object.assign(new Error('duplicate key'), { code: 11000 });
    // Spy to verify wallet deduction was attempted before the error
    const findOneAndUpdateSpy = jest.spyOn(User, 'findOneAndUpdate');
    jest.spyOn(MatchRecord, 'create').mockRejectedValueOnce(dupError);

    const res = await request(testApp).post(`/api/jobs/${job._id}/match`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already matched/i);

    // Wallet WAS debited initially (findOneAndUpdate ran)
    expect(findOneAndUpdateSpy).toHaveBeenCalled();
    findOneAndUpdateSpy.mockRestore();

    // Wallet was REVERSED after the 11000 error — net balance back to 1.0
    const updatedUser = await User.findById(user._id);
    expect(updatedUser!.walletBalance).toBeCloseTo(1.0, 5);

    // No MatchRecord was saved
    const matchRecord = await MatchRecord.findOne({ userId: user._id, jobId: job._id });
    expect(matchRecord).toBeNull();

    // No transaction created
    const tx = await Transaction.findOne({ userId: user._id });
    expect(tx).toBeNull();
  });

  it('second call returns 400 "already matched" (no double charge)', async () => {
    const user = await createUser({ walletBalance: 1.0 });
    currentUser = user;

    const job = await createJob();

    mockMatchUserToJob.mockResolvedValue({
      matchScore: 75,
      verdict: 'Mild match',
      reasoning: 'Good fit',
      freshness: Freshness.FRESH,
    });

    // First call — should succeed
    const res1 = await request(testApp).post(`/api/jobs/${job._id}/match`);
    expect(res1.status).toBe(200);

    // Second call — should fail
    const res2 = await request(testApp).post(`/api/jobs/${job._id}/match`);
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/already matched/i);

    // Wallet deducted only once
    const updatedUser = await User.findById(user._id);
    expect(updatedUser!.walletBalance).toBeCloseTo(0.95, 5);
  });
});
