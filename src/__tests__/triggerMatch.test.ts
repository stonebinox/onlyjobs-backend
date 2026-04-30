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

const createTestUser = async (overrides: Record<string, unknown> = {}) => {
  return User.create({
    _id: testUserId,
    email: 'test@example.com',
    password: '$2b$10$placeholder_hash_for_tests_only', // not used in these tests
    isVerified: true,
    walletBalance: 5,
    ...overrides,
  });
};

beforeEach(() => {
  testUserId = new mongoose.Types.ObjectId();
  mockFetch.mockReset();
  process.env.INTERNAL_TRIGGER_SECRET = 'test-secret';
  process.env.BACKGROUND_SERVICE_URL = 'http://localhost:5001';
});

describe('POST /api/matches/trigger-for-me', () => {
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
  });

  it('returns 429 when called again within 6 hours', async () => {
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

  it('returns 503 when INTERNAL_TRIGGER_SECRET is not set', async () => {
    delete process.env.INTERNAL_TRIGGER_SECRET;
    await createTestUser();

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(503);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 502 when background service is unreachable', async () => {
    await createTestUser();
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await request(testApp).post('/api/matches/trigger-for-me');

    expect(res.status).toBe(502);
  });

  it('does not update cooldown when background service fails', async () => {
    await createTestUser();
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => 'error' } as Response);

    await request(testApp).post('/api/matches/trigger-for-me');

    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeUndefined();
  });

  it('updates cooldown only after successful dispatch', async () => {
    await createTestUser();
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as Response);

    await request(testApp).post('/api/matches/trigger-for-me');

    const user = await User.findById(testUserId);
    expect(user?.lastManualMatchAt).toBeDefined();
  });
});
