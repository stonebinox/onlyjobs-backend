// Must mock auth middleware before importing routes
jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

// Mock global fetch used by triggerMatchForMe
const mockFetch = jest.fn();
global.fetch = mockFetch;

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
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

// Eligible-by-default user — all gates pass
const createTestUser = async (overrides: Record<string, unknown> = {}) => {
  return User.create({
    _id: testUserId,
    email: 'test@example.com',
    password: '$2b$10$placeholder_hash_for_tests_only',
    isVerified: true,
    walletBalance: 5,
    resume: {
      summary: 'Experienced software engineer',
      skills: ['TypeScript', 'Node.js'],
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
    ...overrides,
  });
};

beforeEach(() => {
  testUserId = new mongoose.Types.ObjectId();
  mockFetch.mockReset();
  process.env.INTERNAL_TRIGGER_SECRET = 'test-secret';
  process.env.BACKGROUND_SERVICE_URL = 'http://localhost:5001';
});

describe('POST /api/matches/trigger-for-me — eligibility gates', () => {
  it('returns 403 reason=unverified for unverified user; fetch not called, cooldown not set', async () => {
    await createTestUser({ isVerified: false });

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('unverified');
    expect(mockFetch).not.toHaveBeenCalled();
    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeUndefined();
  });

  it('returns 400 reason=no_resume for whitespace-only resume; fetch not called, cooldown not set', async () => {
    await createTestUser({
      resume: { summary: '   ', skills: ['  '], experience: [], education: [] },
    });

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
    expect(mockFetch).not.toHaveBeenCalled();
    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeUndefined();
  });

  it('returns 400 reason=matching_disabled when matchingEnabled is false; fetch not called, cooldown not set', async () => {
    await createTestUser({
      preferences: {
        matchingEnabled: false,
        remoteOnly: false,
        minSalary: 0,
        location: [],
        jobTypes: [],
        industries: [],
        minScore: 30,
      },
    });

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('matching_disabled');
    expect(mockFetch).not.toHaveBeenCalled();
    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeUndefined();
  });

  it('returns 400 reason=insufficient_balance for walletBalance 0.29; includes walletBalance and required; fetch not called, cooldown not set', async () => {
    await createTestUser({ walletBalance: 0.29 });

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('insufficient_balance');
    expect(res.body.walletBalance).toBe(0.29);
    expect(res.body.required).toBe(0.3);
    expect(mockFetch).not.toHaveBeenCalled();
    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeUndefined();
  });

  it('walletBalance exactly 0.30 passes the balance gate — dispatches and returns 202', async () => {
    await createTestUser({ walletBalance: 0.30 });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as Response);

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(202);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeDefined();
  });
});

describe('POST /api/matches/trigger-for-me — cooldown (atomic)', () => {
  it('returns 429 when lastManualMatchAt is within 6 hours; fetch not called', async () => {
    const recentTrigger = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    await createTestUser({ lastManualMatchAt: recentTrigger });

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(429);
    expect(res.body.retryAfterMinutes).toBeGreaterThan(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows re-trigger after 6 hours have passed', async () => {
    const oldTrigger = new Date(Date.now() - 7 * 60 * 60 * 1000); // 7h ago
    await createTestUser({ lastManualMatchAt: oldTrigger });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as Response);

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(202);
  });
});

describe('POST /api/matches/trigger-for-me — dispatch and rollback', () => {
  it('returns 202 and dispatches to background service when eligible', async () => {
    await createTestUser();
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as Response);

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(202);
    expect(res.body.message).toMatch(/match run started/i);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5001/internal/match-for-user',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Internal-Secret': 'test-secret' }),
        body: JSON.stringify({ userId: testUserId.toString() }),
      })
    );
    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeDefined();
  });

  it('returns 503 when INTERNAL_TRIGGER_SECRET is not set', async () => {
    delete process.env.INTERNAL_TRIGGER_SECRET;
    await createTestUser();

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(503);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 502 and rolls back cooldown when background service returns non-ok', async () => {
    await createTestUser();
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => 'error' } as Response);

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(502);
    const user = await User.findById(testUserId);
    // Rollback: user had no previous lastManualMatchAt, so it is restored to undefined
    expect(user?.lastManualMatchAt).toBeUndefined();
  });

  it('returns 502 and rolls back cooldown when background service is unreachable (fetch throws)', async () => {
    await createTestUser();
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(502);
    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeUndefined();
  });

  it('does not update cooldown when background service fails (non-ok response)', async () => {
    await createTestUser();
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => 'error' } as Response);

    await request(testApp).post('/api/matches/trigger-for-me');

    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeUndefined();
  });

  it('sets lastManualMatchAt after successful dispatch', async () => {
    await createTestUser();
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as Response);

    const before = new Date();
    await request(testApp).post('/api/matches/trigger-for-me');

    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeDefined();
    expect(user!.lastManualMatchAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
