process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({}),
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import MatchRecord, { Freshness } from '../models/MatchRecord';
import JobListing from '../models/JobListing';
import User from '../models/User';
import { generateToken } from '../utils/generateToken';
import matchRoutes from '../routes/matchRoutes';

const userId = new mongoose.Types.ObjectId();

// Real `protect` middleware: auth is exercised, not mocked.
const app = express();
app.use(express.json());
app.use('/api/matches', matchRoutes);
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(res.statusCode !== 200 ? res.statusCode : 500).json({ error: err.message });
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

describe('GET /api/matches/visited (smoke)', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/matches/visited');
    expect(res.status).toBe(401);
  });

  it('returns a clicked, unapplied match with its job', async () => {
    await User.create({
      _id: userId,
      name: 'Visited Test',
      email: `lcmc-visited-${userId.toString()}@example.com`,
      password: 'hashed',
      isVerified: true,
    });
    const token = generateToken(userId.toString());
    const job = await createJob();
    await MatchRecord.create({
      userId,
      jobId: job._id,
      matchScore: 80,
      verdict: 'Good match',
      reasoning: 'r',
      freshness: Freshness.FRESH,
      clicked: true,
      skipped: false,
      applied: null,
    });

    const res = await request(app)
      .get('/api/matches/visited')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].job.title).toBe('Software Engineer');
  });
});
