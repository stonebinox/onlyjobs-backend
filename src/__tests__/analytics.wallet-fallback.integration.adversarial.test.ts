/**
 * Adversarial integration tests: wallet_topup_completed analytics events from
 * the syncTransactionStatus fallback credit path.
 *
 * Real MongoDB via MongoMemoryServer (from global setup.ts).
 * posthog-node SDK mocked so capture() is observable.
 * razorpayService.fetchOrder mocked; order status controllable per test.
 * analyticsService itself is NOT mocked — black box.
 *
 * DISCLOSURE: I read walletController.ts to understand route signatures, the
 * guard conditions (status !== "pending" early-return; !transaction.metadata?.walletCredited),
 * and STALE_TRANSACTION_MINUTES (30). I read walletRoutes.ts for the route path.
 * I read Transaction.ts and User.ts schemas to seed data correctly.
 * I read wallet.test.ts and analytics.lifecycle.integration.adversarial.test.ts
 * for test-setup patterns. I did NOT read analyticsService.ts internals.
 */

// ─── SDK mock — hoisted before all requires ───────────────────────────────────
const mockCapture = jest.fn();
const mockShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: mockCapture,
    shutdown: mockShutdown,
  })),
}));

// ─── razorpayService: mock fetchOrder (plus stubs so imports resolve) ─────────
jest.mock('../services/razorpayService', () => ({
  createOrder: jest.fn(),
  verifyPayment: jest.fn(),
  verifyWebhookSignature: jest.fn(),
  fetchOrder: jest.fn(),
}));

// ─── Auth middleware: bypass protect, inject req.user via middleware below ────
jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';

import User from '../models/User';
import Transaction from '../models/Transaction';
import walletRoutes from '../routes/walletRoutes';
import { fetchOrder } from '../services/razorpayService';

const mockFetchOrder = fetchOrder as jest.Mock;

// ─── Express test application ─────────────────────────────────────────────────
let currentUserId: mongoose.Types.ObjectId | null = null;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  if (currentUserId !== null) req.user = { _id: currentUserId };
  next();
});
testApp.use('/api/wallet', walletRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

// ─── Test lifecycle ────────────────────────────────────────────────────────────
beforeAll(() => {
  // Must be set before the first captureLifecycleEvent call so the lazy singleton initializes with our mock.
  process.env.POSTHOG_KEY = 'fallback-adversarial-test-key';
  process.env.JWT_SECRET = 'test-jwt-secret';
});

afterAll(() => {
  delete process.env.POSTHOG_KEY;
});

beforeEach(() => {
  mockCapture.mockClear();
  mockFetchOrder.mockReset();
  currentUserId = null;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function seedUser(userId: mongoose.Types.ObjectId, walletBalance = 0) {
  return User.create({
    _id: userId,
    name: 'Test User',
    email: `user-${userId.toString()}@test.example.com`,
    password: 'hashed',
    isVerified: true,
    walletBalance,
    resume: { skills: [], experience: [], education: [], summary: '' },
    preferences: {
      jobTypes: [],
      location: [],
      remoteOnly: false,
      minSalary: 0,
      industries: [],
      minScore: 30,
      matchingEnabled: true,
    },
  });
}

async function seedPendingTx(
  userId: mongoose.Types.ObjectId,
  orderId: string,
  amount = 25,
  metadata: Record<string, any> = {}
) {
  return Transaction.create({
    userId,
    type: 'credit',
    amount,
    description: `Wallet top-up - $${amount}`,
    razorpayOrderId: orderId,
    status: 'pending',
    metadata,
  });
}

function topupCount(): number {
  return mockCapture.mock.calls.filter((c: any[]) => c[0]?.event === 'wallet_topup_completed').length;
}

function topupCalls(): any[] {
  return mockCapture.mock.calls
    .filter((c: any[]) => c[0]?.event === 'wallet_topup_completed')
    .map((c: any[]) => c[0]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Path 1: syncTransactionStatus — GET /api/wallet/sync/:orderId
// ═══════════════════════════════════════════════════════════════════════════════
describe('syncTransactionStatus — wallet_topup_completed analytics', () => {

  it('EXACTLY-ONE: pending + paid order emits exactly 1 event with correct distinctId', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId, 0);
    await seedPendingTx(userId, 'order_s1');
    mockFetchOrder.mockResolvedValue({ status: 'paid' });
    currentUserId = userId;

    const res = await request(testApp).get('/api/wallet/sync/order_s1');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');

    const calls = topupCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].distinctId).toBe(userId.toString());
  });

  it('EXACTLY-ONE: walletBalance actually increases — proves real credit path, not a no-op', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId, 10);
    await seedPendingTx(userId, 'order_s_balance', 30);
    mockFetchOrder.mockResolvedValue({ status: 'paid' });
    currentUserId = userId;

    await request(testApp).get('/api/wallet/sync/order_s_balance');

    const after = await User.findById(userId);
    expect(after!.walletBalance).toBe(40); // 10 + 30
  });

  it('ZERO: transaction already completed — returns early, fetchOrder never called, no event', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId, 20);
    await Transaction.create({
      userId,
      type: 'credit',
      amount: 20,
      description: 'Top-up $20',
      razorpayOrderId: 'order_s_done',
      status: 'completed',
      metadata: { walletCredited: true },
    });
    currentUserId = userId;

    const res = await request(testApp).get('/api/wallet/sync/order_s_done');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    // The early-return path must not touch fetchOrder or analytics
    expect(mockFetchOrder).not.toHaveBeenCalled();
    expect(topupCount()).toBe(0);
  });

  it('ZERO: order status "created" — transaction stays pending, no event', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId, 0);
    await seedPendingTx(userId, 'order_s_created');
    mockFetchOrder.mockResolvedValue({ status: 'created' });
    currentUserId = userId;

    const res = await request(testApp).get('/api/wallet/sync/order_s_created');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(topupCount()).toBe(0);
  });

  it('ZERO: order status "attempted" — transaction stays pending, no event', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId, 0);
    await seedPendingTx(userId, 'order_s_attempted');
    mockFetchOrder.mockResolvedValue({ status: 'attempted' });
    currentUserId = userId;

    const res = await request(testApp).get('/api/wallet/sync/order_s_attempted');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(topupCount()).toBe(0);
  });

  it('ZERO: metadata.walletCredited=true — paid order but guard blocks re-credit; balance unchanged', async () => {
    const userId = new mongoose.Types.ObjectId();
    const originalBalance = 50;
    await seedUser(userId, originalBalance);
    // Pending but walletCredited already set (e.g. sync ran once, credit succeeded, status save failed)
    await seedPendingTx(userId, 'order_s_guard', 25, { walletCredited: true });
    mockFetchOrder.mockResolvedValue({ status: 'paid' });
    currentUserId = userId;

    const res = await request(testApp).get('/api/wallet/sync/order_s_guard');

    expect(res.status).toBe(200); // syncs the status field but does not double-credit
    expect(topupCount()).toBe(0);
    const after = await User.findById(userId);
    expect(after!.walletBalance).toBe(originalBalance); // must not change
  });

  it('ZERO: cross-user access — transaction belongs to a different user, returns 404, no event', async () => {
    const owner = new mongoose.Types.ObjectId();
    const attacker = new mongoose.Types.ObjectId();
    await seedUser(owner, 0);
    await seedUser(attacker, 0);
    await seedPendingTx(owner, 'order_s_xuser', 25);
    mockFetchOrder.mockResolvedValue({ status: 'paid' });
    currentUserId = attacker; // wrong user making the request

    const res = await request(testApp).get('/api/wallet/sync/order_s_xuser');

    expect(res.status).toBe(404);
    expect(topupCount()).toBe(0);
    // Owner's wallet must not have been credited
    const ownerAfter = await User.findById(owner);
    expect(ownerAfter!.walletBalance).toBe(0);
  });
});
