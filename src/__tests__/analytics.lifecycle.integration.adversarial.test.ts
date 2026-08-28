/**
 * Adversarial integration tests: lifecycle event exactly-once + zero-on-reject.
 *
 * Strategy: real MongoDB (MongoMemoryServer), real controllers, mocked SDK only.
 * posthog-node is mocked so capture() calls are observable.
 * analyticsService itself is NOT mocked.
 *
 * POSTHOG_KEY is set in beforeAll; analyticsService uses a lazy singleton so
 * the key is read on the first captureLifecycleEvent call (which happens inside tests,
 * after beforeAll has run).
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

// ─── Mocks for external dependencies ─────────────────────────────────────────
jest.mock('../services/emailService', () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(undefined),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(undefined),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/razorpayService', () => ({
  createOrder: jest.fn(),
  verifyPayment: jest.fn(),
  verifyWebhookSignature: jest.fn(),
  fetchOrder: jest.fn(),
}));

jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

// Mock matchingService entirely to avoid OpenAI at load time
jest.mock('../services/matchingService', () => ({
  matchUserToJob: jest.fn(),
  deleteAllMatches: jest.fn().mockResolvedValue(undefined),
  getMatchesData: jest.fn().mockResolvedValue([]),
  markMatchAsClicked: jest.fn().mockResolvedValue(undefined),
  skipMatch: jest.fn().mockResolvedValue(null),
  markMatchAppliedStatus: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/preferenceLearningService', () => ({
  analyzeRejectionAndUpdatePreferences: jest.fn().mockResolvedValue(null),
}));

// bcrypt: avoid native binary issues in CI
jest.mock('bcrypt', () => ({
  hash: (_pw: string, _r: number) => Promise.resolve(`hashed_${_pw}`),
  compare: (pw: string, hash: string) => Promise.resolve(hash === `hashed_${pw}`),
}));

// OpenAI: prevent module-level instantiation errors
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({
    chat: { completions: { create: jest.fn() } },
    audio: { transcriptions: { create: jest.fn() } },
  }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';

import User from '../models/User';
import Transaction from '../models/Transaction';
import MatchRecord from '../models/MatchRecord';
import JobListing from '../models/JobListing';
import userRoutes from '../routes/userRoutes';
import walletRoutes from '../routes/walletRoutes';
import jobRoutes from '../routes/jobRoutes';

import { verifyPayment, verifyWebhookSignature } from '../services/razorpayService';
import { matchUserToJob } from '../services/matchingService';

const mockVerifyPayment = verifyPayment as jest.Mock;
const mockVerifyWebhookSignature = verifyWebhookSignature as jest.Mock;
const mockMatchUserToJob = matchUserToJob as jest.Mock;

// ─── Express test application ─────────────────────────────────────────────────
let currentUser: any = null; // overridden per test for auth injection

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  if (currentUser !== null) req.user = currentUser;
  next();
});
testApp.use('/api/users', userRoutes);
testApp.use('/api/wallet', walletRoutes);
testApp.use('/api/jobs', jobRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

// ─── Test lifecycle ────────────────────────────────────────────────────────────
beforeAll(() => {
  // Enable analytics: key must be set before the first captureLifecycleEvent call.
  // The service uses lazy initialization (_initialized=false at module load).
  process.env.POSTHOG_KEY = 'integration-adversarial-key';
  process.env.JWT_SECRET = 'test-jwt-secret';
});

afterAll(() => {
  delete process.env.POSTHOG_KEY;
});

beforeEach(() => {
  mockCapture.mockClear();
  mockVerifyPayment.mockReset();
  mockVerifyWebhookSignature.mockReset();
  mockMatchUserToJob.mockReset();
  currentUser = null;
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeUserId() {
  return new mongoose.Types.ObjectId();
}

async function createVerifiedUser(userId: mongoose.Types.ObjectId, overrides: Record<string, any> = {}) {
  return User.create({
    _id: userId,
    email: `user-${userId.toString()}@test.example.com`,
    password: 'hashed_pass',
    isVerified: true,
    walletBalance: 5,
    currentLocation: 'Bangalore, India',
    resume: {
      summary: 'Senior engineer with TypeScript experience',
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
}

async function createRecentJob() {
  const postedDate = new Date();
  postedDate.setDate(postedDate.getDate() - 5); // 5 days ago, within 15-day window
  return JobListing.create({
    title: 'Senior TypeScript Engineer',
    company: 'Acme Corp',
    location: ['Remote'],
    description: 'Build great things with TypeScript',
    source: 'test',
    url: 'https://example.com/job/1',
    postedDate,
    scrapedDate: new Date(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// email_verified — verifyInitialEmail
// ═══════════════════════════════════════════════════════════════════════════════
describe('email_verified — verifyInitialEmail lifecycle event', () => {

  it('emits exactly one email_verified with correct distinctId on valid token', async () => {
    const token = crypto.randomBytes(32).toString('hex');
    const userId = makeUserId();
    await User.create({
      _id: userId,
      email: `unverified-${userId}@test.example.com`,
      password: 'hashed_pass',
      isVerified: false,
      emailVerificationToken: token,
      emailVerificationExpires: new Date(Date.now() + 3600 * 1000),
      // pendingEmail NOT set — this is initial verification, not email-change
    });

    const res = await request(testApp)
      .post('/api/users/verify-email')
      .send({ token });

    expect(res.status).toBe(200);
    expect(mockCapture).toHaveBeenCalledTimes(1);

    const call = mockCapture.mock.calls[0][0];
    expect(call.distinctId).toBe(userId.toString());
    expect(call.event).toBe('email_verified');
  });

  it('emits ZERO events for an expired/invalid token', async () => {
    const res = await request(testApp)
      .post('/api/users/verify-email')
      .send({ token: 'nonexistent-garbage-token-abc123' });

    expect(res.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO events for an expired token (token exists but past expiry)', async () => {
    const token = crypto.randomBytes(32).toString('hex');
    const userId = makeUserId();
    await User.create({
      _id: userId,
      email: `expired-${userId}@test.example.com`,
      password: 'hashed_pass',
      isVerified: false,
      emailVerificationToken: token,
      emailVerificationExpires: new Date(Date.now() - 1000), // already expired
    });

    const res = await request(testApp)
      .post('/api/users/verify-email')
      .send({ token });

    expect(res.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO email_verified events via the email-change/verify path (verifyEmailChange)', async () => {
    // User with pendingEmail: the initial-verify query filters these out.
    // verifyEmailChange succeeds but does NOT emit email_verified.
    const token = crypto.randomBytes(32).toString('hex');
    const userId = makeUserId();
    const pendingEmail = `new-email-${userId}@test.example.com`;
    await User.create({
      _id: userId,
      email: `old-email-${userId}@test.example.com`,
      password: 'hashed_pass',
      isVerified: true,
      pendingEmail,
      emailVerificationToken: token,
      emailVerificationExpires: new Date(Date.now() + 3600 * 1000),
    });

    // Call the EMAIL-CHANGE path (different endpoint)
    const changeRes = await request(testApp)
      .post('/api/users/email-change/verify')
      .send({ token });

    // Email change verifies successfully
    expect(changeRes.status).toBe(200);

    // ZERO email_verified analytics events — verifyEmailChange does not emit one
    const emailVerifiedCalls = mockCapture.mock.calls.filter(
      (c) => c[0]?.event === 'email_verified'
    );
    expect(emailVerifiedCalls).toHaveLength(0);
  });

  it('POST /verify-email with pendingEmail-token returns 400 (query excludes pendingEmail users)', async () => {
    // Calling verifyInitialEmail with a token that belongs to an email-change user
    // → not found by the query → 400 → ZERO events
    const token = crypto.randomBytes(32).toString('hex');
    const userId = makeUserId();
    await User.create({
      _id: userId,
      email: `base-${userId}@test.example.com`,
      password: 'hashed_pass',
      isVerified: true,
      pendingEmail: `new-${userId}@test.example.com`,
      emailVerificationToken: token,
      emailVerificationExpires: new Date(Date.now() + 3600 * 1000),
    });

    const res = await request(testApp)
      .post('/api/users/verify-email')
      .send({ token });

    expect(res.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// on_demand_match — matchJobOnDemand
// ═══════════════════════════════════════════════════════════════════════════════
describe('on_demand_match — matchJobOnDemand lifecycle event', () => {

  beforeEach(() => {
    // Default mock: valid match result
    mockMatchUserToJob.mockResolvedValue({
      matchScore: 85,
      verdict: 'Match',
      reasoning: 'Great fit for the role',
      freshness: 'Fresh',
    });
  });

  it('emits exactly one on_demand_match on success (wallet debited + MatchRecord created)', async () => {
    const userId = makeUserId();
    await createVerifiedUser(userId, { walletBalance: 5, currentLocation: 'Bangalore, India' });
    const job = await createRecentJob();

    currentUser = {
      _id: userId,
      isVerified: true,
      walletBalance: 5,
      currentLocation: 'Bangalore, India',
      resume: { summary: 'Senior engineer', skills: ['TypeScript'], experience: [], education: [] },
    };

    const res = await request(testApp)
      .post(`/api/jobs/${job._id}/match`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(1);

    const call = mockCapture.mock.calls[0][0];
    expect(call.distinctId).toBe(userId.toString());
    expect(call.event).toBe('on_demand_match');
  });

  it('emits ZERO events when balance is insufficient (< 0.05)', async () => {
    const userId = makeUserId();
    const job = await createRecentJob();

    currentUser = {
      _id: userId,
      isVerified: true,
      walletBalance: 0.04, // below ON_DEMAND_MATCH_COST=0.05
      resume: { summary: 'Engineer', skills: ['TypeScript'], experience: [], education: [] },
    };

    const res = await request(testApp)
      .post(`/api/jobs/${job._id}/match`);

    expect(res.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO events for unverified user', async () => {
    const userId = makeUserId();
    const job = await createRecentJob();

    currentUser = {
      _id: userId,
      isVerified: false,
      walletBalance: 5,
      resume: { summary: 'Engineer', skills: ['TypeScript'], experience: [], education: [] },
    };

    const res = await request(testApp)
      .post(`/api/jobs/${job._id}/match`);

    expect(res.status).toBe(403);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO events when MatchRecord already exists for (userId, jobId) — pre-check rejects', async () => {
    const userId = makeUserId();
    await createVerifiedUser(userId);
    const job = await createRecentJob();

    // Create a pre-existing MatchRecord
    await MatchRecord.create({
      userId,
      jobId: job._id,
      matchScore: 70,
      verdict: 'Match',
      reasoning: 'Prior match',
      freshness: 'Fresh',
      clicked: false,
      skipped: false,
      applied: null,
    });

    currentUser = {
      _id: userId,
      isVerified: true,
      walletBalance: 5,
      resume: { summary: 'Engineer', skills: ['TypeScript'], experience: [], education: [] },
    };

    const res = await request(testApp)
      .post(`/api/jobs/${job._id}/match`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already matched/i);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO events on race-condition 11000 duplicate key (refund path)', async () => {
    // Simulate the race: pre-check passes (no existing record), then MatchRecord.create
    // throws E11000 (another request won the race). Wallet must be refunded, NO analytics.
    const userId = makeUserId();
    await createVerifiedUser(userId, { walletBalance: 5 });
    const job = await createRecentJob();

    // Spy: make MatchRecord.create throw 11000
    const createSpy = jest.spyOn(MatchRecord, 'create').mockImplementationOnce(() => {
      const err = new Error('E11000 duplicate key error collection: matchrecords');
      (err as any).code = 11000;
      return Promise.reject(err);
    });

    currentUser = {
      _id: userId,
      isVerified: true,
      walletBalance: 5,
      resume: { summary: 'Engineer', skills: ['TypeScript'], experience: [], education: [] },
    };

    const res = await request(testApp)
      .post(`/api/jobs/${job._id}/match`);

    createSpy.mockRestore();

    expect(res.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO events for a stale/absent job (not found in DB)', async () => {
    const userId = makeUserId();
    const nonExistentJobId = new mongoose.Types.ObjectId();

    currentUser = {
      _id: userId,
      isVerified: true,
      walletBalance: 5,
      resume: { summary: 'Engineer', skills: ['TypeScript'], experience: [], education: [] },
    };

    const res = await request(testApp)
      .post(`/api/jobs/${nonExistentJobId}/match`);

    expect(res.status).toBe(404);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO events for user with no meaningful resume', async () => {
    const userId = makeUserId();
    const job = await createRecentJob();

    currentUser = {
      _id: userId,
      isVerified: true,
      walletBalance: 5,
      resume: { summary: '', skills: [], experience: [], education: [] },
    };

    const res = await request(testApp)
      .post(`/api/jobs/${job._id}/match`);

    expect(res.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// wallet_topup_completed — verifyAndCreditWallet
// ═══════════════════════════════════════════════════════════════════════════════
describe('wallet_topup_completed — verifyAndCreditWallet', () => {

  async function createUserAndPendingTx(userId: mongoose.Types.ObjectId, orderId: string, amount = 10) {
    await createVerifiedUser(userId, { walletBalance: 0 });
    await Transaction.create({
      userId,
      type: 'credit',
      amount,
      description: `Wallet top-up - $${amount}`,
      razorpayOrderId: orderId,
      status: 'pending',
    });
  }

  it('emits exactly one wallet_topup_completed on valid payment verification', async () => {
    const userId = makeUserId();
    const orderId = `order_valid_${userId}`;
    await createUserAndPendingTx(userId, orderId);

    currentUser = { _id: userId };
    mockVerifyPayment.mockReturnValue(true);

    const res = await request(testApp)
      .post('/api/wallet/verify-payment')
      .send({ orderId, paymentId: `pay_${userId}`, signature: 'valid_sig' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0][0].event).toBe('wallet_topup_completed');
    expect(mockCapture.mock.calls[0][0].distinctId).toBe(userId.toString());
  });

  it('emits ZERO events when payment signature is invalid', async () => {
    const userId = makeUserId();
    const orderId = `order_badsig_${userId}`;
    await createUserAndPendingTx(userId, orderId);

    currentUser = { _id: userId };
    mockVerifyPayment.mockReturnValue(false);

    const res = await request(testApp)
      .post('/api/wallet/verify-payment')
      .send({ orderId, paymentId: `pay_bad`, signature: 'bad_sig' });

    expect(res.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO events when no matching pending transaction exists', async () => {
    const userId = makeUserId();
    await createVerifiedUser(userId);

    currentUser = { _id: userId };
    mockVerifyPayment.mockReturnValue(true);

    const res = await request(testApp)
      .post('/api/wallet/verify-payment')
      .send({ orderId: 'order_nonexistent', paymentId: 'pay_x', signature: 'sig_x' });

    expect(res.status).toBe(404);
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// wallet_topup_completed — Razorpay webhook (handleRazorpayWebhook)
// ═══════════════════════════════════════════════════════════════════════════════
describe('wallet_topup_completed — Razorpay webhook', () => {

  function webhookBody(orderId: string, paymentId: string, event = 'payment.captured') {
    return {
      event,
      payload: {
        payment: { entity: { order_id: orderId, id: paymentId } },
      },
    };
  }

  it('emits exactly one wallet_topup_completed for payment.captured (new pending tx)', async () => {
    const userId = makeUserId();
    const orderId = `order_wh_${userId}`;
    await createVerifiedUser(userId, { walletBalance: 0 });
    await Transaction.create({
      userId,
      type: 'credit',
      amount: 15,
      description: 'Wallet top-up - $15',
      razorpayOrderId: orderId,
      status: 'pending',
    });

    mockVerifyWebhookSignature.mockReturnValue(true);

    const res = await request(testApp)
      .post('/api/wallet/webhook')
      .set('x-razorpay-signature', 'valid_sig')
      .send(webhookBody(orderId, `pay_wh_${userId}`));

    expect(res.status).toBe(200);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0][0].event).toBe('wallet_topup_completed');
    expect(mockCapture.mock.calls[0][0].distinctId).toBe(userId.toString());
  });

  it('emits ZERO additional events for a duplicate/replay webhook (already-completed tx)', async () => {
    const userId = makeUserId();
    const orderId = `order_wh_dup_${userId}`;
    await createVerifiedUser(userId, { walletBalance: 15 }); // already credited
    // Transaction already completed with walletCredited=true
    await Transaction.create({
      userId,
      type: 'credit',
      amount: 15,
      description: 'Wallet top-up - $15',
      razorpayOrderId: orderId,
      status: 'completed', // already done
      metadata: { walletCredited: true },
    });

    mockVerifyWebhookSignature.mockReturnValue(true);

    const res = await request(testApp)
      .post('/api/wallet/webhook')
      .set('x-razorpay-signature', 'valid_sig')
      .send(webhookBody(orderId, `pay_wh_dup_${userId}`));

    expect(res.status).toBe(200); // always 200 for webhooks
    // The outer idempotency check: transaction.status === 'completed' → skip entire block → NO analytics
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO events when webhook signature is invalid', async () => {
    const userId = makeUserId();
    const orderId = `order_wh_badsig_${userId}`;

    mockVerifyWebhookSignature.mockReturnValue(false);

    const res = await request(testApp)
      .post('/api/wallet/webhook')
      .set('x-razorpay-signature', 'bad_sig')
      .send(webhookBody(orderId, 'pay_badsig'));

    expect(res.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('emits ZERO events for payment.failed webhook', async () => {
    const userId = makeUserId();
    const orderId = `order_wh_failed_${userId}`;
    await createVerifiedUser(userId, { walletBalance: 0 });
    await Transaction.create({
      userId,
      type: 'credit',
      amount: 10,
      description: 'Wallet top-up - $10',
      razorpayOrderId: orderId,
      status: 'pending',
    });

    mockVerifyWebhookSignature.mockReturnValue(true);

    const res = await request(testApp)
      .post('/api/wallet/webhook')
      .set('x-razorpay-signature', 'valid_sig')
      .send({
        event: 'payment.failed',
        payload: { payment: { entity: { order_id: orderId, id: `pay_failed_${userId}` } } },
      });

    expect(res.status).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('first webhook credits + emits once; second replay emits ZERO additional (idempotency)', async () => {
    const userId = makeUserId();
    const orderId = `order_wh_idp_${userId}`;
    await createVerifiedUser(userId, { walletBalance: 0 });
    await Transaction.create({
      userId,
      type: 'credit',
      amount: 20,
      description: 'Wallet top-up - $20',
      razorpayOrderId: orderId,
      status: 'pending',
    });

    mockVerifyWebhookSignature.mockReturnValue(true);
    const body = webhookBody(orderId, `pay_idp_${userId}`);

    // First delivery
    await request(testApp)
      .post('/api/wallet/webhook')
      .set('x-razorpay-signature', 'valid_sig')
      .send(body);
    expect(mockCapture).toHaveBeenCalledTimes(1);

    mockCapture.mockClear();

    // Second delivery (replay)
    await request(testApp)
      .post('/api/wallet/webhook')
      .set('x-razorpay-signature', 'valid_sig')
      .send(body);
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
