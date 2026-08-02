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

async function makeUser() {
  emailCounter++;
  return User.create({
    _id: testUserId,
    name: 'Test',
    email: `tracker-test-${emailCounter}-${Date.now()}@example.com`,
    password: 'hashed',
    isVerified: true,
    resume: {
      summary: 'Engineer',
      skills: ['JS'],
      experience: [],
      education: [],
    },
    preferences: {
      matchingEnabled: true,
      remoteOnly: false,
      minSalary: 0,
      location: [],
      jobTypes: [],
      industries: [],
      minScore: 30,
    },
    walletBalance: 1.00,
    skippedJobs: [],
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

describe('GET /api/matches/tracker', () => {
  it('returns applied records and excludes non-applied ones', async () => {
    await makeUser();
    const jobA = await createJob({ title: 'Applied Job' });
    const jobB = await createJob({ title: 'Not Applied Job' });

    await MatchRecord.create({
      userId: testUserId,
      jobId: jobA._id,
      matchScore: 80,
      verdict: 'Good',
      reasoning: 'test',
      applied: true,
      appliedAt: new Date(),
    });

    await MatchRecord.create({
      userId: testUserId,
      jobId: jobB._id,
      matchScore: 70,
      verdict: 'OK',
      reasoning: 'test',
      applied: false,
    });

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].applied).toBe(true);
    expect(res.body[0].job).not.toBeNull();
    expect(res.body[0].job.title).toBe('Applied Job');
  });

  it('keeps records whose job listing was deleted (returns job: null)', async () => {
    await makeUser();
    const deletedJobId = new mongoose.Types.ObjectId(); // no matching listing in DB

    await MatchRecord.create({
      userId: testUserId,
      jobId: deletedJobId,
      matchScore: 75,
      verdict: 'Good',
      reasoning: 'test',
      applied: true,
      appliedAt: new Date(),
    });

    const res = await request(testApp).get('/api/matches/tracker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].job).toBeNull();
  });
});
