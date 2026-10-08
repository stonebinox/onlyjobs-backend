/**
 * Smoke test: getOutOfCreditPreview applies the per-company cap so the returned count
 * reflects what the nightly matcher would actually see (capped pool), not the raw
 * eligible count.
 */

jest.mock('../middleware/authMiddleware', () => ({
  protect: (req: any, _res: any, next: any) => {
    req.user = (req as any)._testUser;
    next();
  },
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import JobListing from '../models/JobListing';
import MatchRecord from '../models/MatchRecord';
import { COMPANY_CAP_K } from '../utils/capNewJobsByCompany';

const testApp = express();
testApp.use(express.json());

let testUserId: string;
testApp.use((req: any, _res: any, next: any) => {
  req._testUser = { _id: testUserId };
  next();
});

import matchRoutes from '../routes/matchRoutes';
testApp.use('/api/matches', matchRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

const DAY = 86400000;

async function makeTestUser(): Promise<string> {
  const user = await User.create({
    name: 'Preview Test',
    email: `preview-cap-test-${Date.now()}@test.com`,
    password: 'hashed',
    isVerified: true,
    walletBalance: 0.0, // below DAILY_MATCH_COST
    matchingDisabledReason: 'auto_low_balance',
    preferences: { matchingEnabled: false },
    resume: { summary: 'Engineer with 5 years experience.' },
  });
  return String(user._id);
}

async function makeJob(company: string, daysAgo: number): Promise<void> {
  const postedDate = new Date(Date.now() - daysAgo * DAY);
  await JobListing.create({
    title: `Job at ${company}`,
    company,
    location: ['Remote'],
    salary: { min: 50000, max: 150000, currency: 'USD' },
    tags: [],
    source: 'test',
    description: 'test',
    url: `http://test/${company}/${daysAgo}/${Date.now()}`,
    dedupKey: `http://test/${company}/${daysAgo}/${Date.now()}`,
    postedDate,
    scrapedDate: new Date(),
  });
}

describe('getOutOfCreditPreview — per-company cap applied', () => {
  beforeEach(async () => {
    testUserId = await makeTestUser();
  });

  it(`count reflects capped pool (K=${COMPANY_CAP_K}) for ${COMPANY_CAP_K + 1} same-company eligible jobs`, async () => {
    // Create K+1 jobs from the same company
    for (let i = 0; i < COMPANY_CAP_K + 1; i++) {
      await makeJob('AcmeCorp', i);
    }

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.shouldShow).toBe(true);
    // Count must be capped at K, not K+1
    expect(res.body.count).toBe(COMPANY_CAP_K);
  });

  it('count is not capped when each job is from a different company', async () => {
    const companies = ['Alpha', 'Beta', 'Gamma', 'Delta'];
    for (let i = 0; i < companies.length; i++) {
      await makeJob(companies[i], i);
    }

    const res = await request(testApp).get('/api/matches/out-of-credit-preview');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(companies.length); // no capping
  });
});
