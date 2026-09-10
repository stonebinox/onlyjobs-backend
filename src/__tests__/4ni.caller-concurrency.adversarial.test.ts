// Adversarial integration tests for double-credit / marker-clobber via real callers + real DB.
// Contract under test: a given razorpayOrderId is credited EXACTLY ONCE across all paths
// (verify-payment, webhook payment.captured/order.paid, failure writers) regardless of concurrency.
//
// WHAT IS FORBIDDEN (not read): creditWallet.ts, walletController.ts, and existing __tests__.
// WHAT WAS READ: app.ts, Transaction.ts, User.ts, analyticsService.ts, razorpayService.ts,
//               generateToken.ts, walletRoutes.ts, authMiddleware.ts, frontend apiClient.ts.

// Set env vars before any module is imported; razorpayService / jwt read them at call time.
process.env.JWT_SECRET = 'test-jwt-secret-4ni';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret-4ni';
process.env.RAZORPAY_KEY_SECRET = 'test-key-secret-4ni';
process.env.RAZORPAY_KEY_ID = 'test-key-id-4ni';

import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';
import User from '../models/User';
import Transaction from '../models/Transaction';
import * as analytics from '../services/analyticsService';

// setup.ts connects MongoMemoryServer in beforeAll and clears collections in afterEach.

const WEBHOOK_SECRET = 'test-webhook-secret-4ni';
const KEY_SECRET = 'test-key-secret-4ni';
const JWT_SECRET = 'test-jwt-secret-4ni';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signWebhookBody(body: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function signVerifyPayment(orderId: string, paymentId: string): string {
  return crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

function makeWebhookJson(
  event: 'payment.captured' | 'order.paid' | 'payment.failed',
  orderId: string,
  paymentId: string,
): string {
  const extras =
    event === 'payment.failed'
      ? {
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Test payment failure',
          error_reason: 'payment_failed',
        }
      : {};
  return JSON.stringify({
    event,
    payload: {
      payment: { entity: { id: paymentId, order_id: orderId, ...extras } },
      order: { entity: { id: orderId } },
    },
  });
}

async function webhook(
  event: 'payment.captured' | 'order.paid' | 'payment.failed',
  orderId: string,
  paymentId: string,
) {
  const body = makeWebhookJson(event, orderId, paymentId);
  const sig = signWebhookBody(body);
  return request(app)
    .post('/api/wallet/webhook')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', sig)
    .send(body);
}

async function verifyPayment(orderId: string, paymentId: string, token: string) {
  const sig = signVerifyPayment(orderId, paymentId);
  return request(app)
    .post('/api/wallet/verify-payment')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId, paymentId, signature: sig });
}

async function cancelOrder(orderId: string, token: string) {
  return request(app)
    .post('/api/wallet/cancel-order')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId });
}

async function seedUserAndPendingTxn(orderId: string, amount = 5) {
  const user = await User.create({
    email: `4ni-test-${orderId}@example.com`,
    password: 'hashed-pw',
    walletBalance: 0,
    isVerified: true,
    preferences: {
      jobTypes: [],
      location: [],
      remoteOnly: false,
      minSalary: 0,
      industries: [],
      minScore: 30,
      matchingEnabled: true,
    },
    resume: {
      skills: [],
      experience: [],
      education: [],
      summary: '',
      certifications: [],
      languages: [],
      projects: [],
      achievements: [],
      volunteerExperience: [],
      interests: [],
    },
    balanceReminderCount: 0,
    noResumeReminderCount: 0,
    qna: [],
  });
  const txn = await Transaction.create({
    userId: user._id,
    type: 'credit',
    amount,
    description: 'Wallet top-up',
    razorpayOrderId: orderId,
    status: 'pending',
    metadata: {},
  });
  const token = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
  return { user, txn, token };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('4ni — caller-concurrency: double-credit / marker-clobber', () => {
  let analyticsSpy: jest.SpyInstance;

  beforeEach(() => {
    analyticsSpy = jest
      .spyOn(analytics, 'captureLifecycleEvent')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: verify-payment ↔ payment.captured concurrent, same order
  // -------------------------------------------------------------------------
  it('T1 verify + payment.captured concurrent → balance = 5 (not 10), analytics = 1×', async () => {
    const orderId = 'order_t1_4ni';
    const paymentId = 'pay_t1_4ni';
    const { token } = await seedUserAndPendingTxn(orderId, 5);

    await Promise.all([
      verifyPayment(orderId, paymentId, token),
      webhook('payment.captured', orderId, paymentId),
    ]);

    const txn = await Transaction.findOne({ razorpayOrderId: orderId });
    const user = await User.findById(txn?.userId);

    // FINDING if balance !== 5: double-credit through concurrent verify + webhook paths
    expect(user?.walletBalance).toBe(5);
    expect(txn?.status).toBe('completed');
    expect(txn?.metadata?.walletCredited).toBe(true);

    // FINDING if analyticsSpy.mock.calls.length !== 1: analytics fired 0 or 2+ times
    expect(analyticsSpy).toHaveBeenCalledTimes(1);
    expect(analyticsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.anything() }),
      'wallet_topup_completed',
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: payment.captured ↔ order.paid concurrent, same order
  // -------------------------------------------------------------------------
  it('T2 payment.captured + order.paid concurrent → balance = 5, analytics = 1×', async () => {
    const orderId = 'order_t2_4ni';
    const paymentId = 'pay_t2_4ni';
    await seedUserAndPendingTxn(orderId, 5);

    await Promise.all([
      webhook('payment.captured', orderId, paymentId),
      webhook('order.paid', orderId, paymentId),
    ]);

    const txn = await Transaction.findOne({ razorpayOrderId: orderId });
    const user = await User.findById(txn?.userId);

    // FINDING if balance !== 5: two different webhook events both triggered a credit
    expect(user?.walletBalance).toBe(5);
    expect(txn?.status).toBe('completed');
    expect(txn?.metadata?.walletCredited).toBe(true);
    expect(analyticsSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 3a: STALE-FAILURE RACE — payment.captured racing payment.failed
  // The failure writer is atomic, gated to status:"pending" → must NOT clobber
  // a completed+credited transaction.
  // -------------------------------------------------------------------------
  it('T3a payment.captured + payment.failed concurrent → completed wins, balance = 5, marker preserved', async () => {
    const orderId = 'order_t3a_4ni';
    const paymentId = 'pay_t3a_4ni';
    await seedUserAndPendingTxn(orderId, 5);

    await Promise.all([
      webhook('payment.captured', orderId, paymentId),
      webhook('payment.failed', orderId, paymentId),
    ]);

    const txn = await Transaction.findOne({ razorpayOrderId: orderId });
    const user = await User.findById(txn?.userId);

    if (user?.walletBalance === 5) {
      // Capture won: marker must be intact
      // FINDING if status !== "completed": failure writer clobbered completed status
      expect(txn?.status).toBe('completed');
      // FINDING if walletCredited !== true: failure writer erased the credit marker
      expect(txn?.metadata?.walletCredited).toBe(true);
      expect(analyticsSpy).toHaveBeenCalledTimes(1);
    } else if (user?.walletBalance === 0) {
      // Failure won atomically (failure ran first on pending, then capture found no pending txn)
      // This is acceptable IF analytics was never fired (no phantom credit)
      expect(analyticsSpy).toHaveBeenCalledTimes(0);
      expect(txn?.status).toBe('failed');
    } else {
      // FINDING: balance is neither 0 nor 5 — corrupted state (double-credit or partial)
      throw new Error(
        `FINDING: balance ${user?.walletBalance} is neither 0 (failure won) nor 5 (capture won). Corrupted state.`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Test 3b: STALE-FAILURE RACE — payment.captured racing cancel-order
  // cancel-order must not clobber a completed+credited transaction
  // -------------------------------------------------------------------------
  it('T3b payment.captured + cancel-order concurrent → no corruption: either credited-5 or cancelled-0', async () => {
    const orderId = 'order_t3b_4ni';
    const paymentId = 'pay_t3b_4ni';
    const { token } = await seedUserAndPendingTxn(orderId, 5);

    await Promise.all([
      webhook('payment.captured', orderId, paymentId),
      cancelOrder(orderId, token),
    ]);

    const txn = await Transaction.findOne({ razorpayOrderId: orderId });
    const user = await User.findById(txn?.userId);

    const captureWon = user?.walletBalance === 5 && txn?.status === 'completed';
    const cancelWon = user?.walletBalance === 0 && txn?.status === 'failed';

    // FINDING if neither: double-credit or marker-clobber (balance > 0 while status=failed)
    expect(captureWon || cancelWon).toBe(true);

    if (captureWon) {
      // FINDING if walletCredited missing: cancel-order erased the marker after credit
      expect(txn?.metadata?.walletCredited).toBe(true);
      expect(analyticsSpy).toHaveBeenCalledTimes(1);
    } else {
      expect(analyticsSpy).toHaveBeenCalledTimes(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: FIX A — historical completed row WITHOUT metadata.walletCredited
  // A legacy row (status:"completed" but no walletCredited flag) must NOT be
  // re-credited. The atomic guard is status:!="completed" — so the filter alone
  // protects it, independently of the metadata flag.
  // -------------------------------------------------------------------------
  it('T4 FIX A: completed txn lacking walletCredited → webhook does NOT re-credit (balance stays 0)', async () => {
    const orderId = 'order_t4_4ni';
    const paymentId = 'pay_t4_4ni';
    const { txn: rawTxn } = await seedUserAndPendingTxn(orderId, 5);

    // Simulate a legacy row: status=completed but no walletCredited marker, balance still 0
    await Transaction.updateOne(
      { _id: rawTxn._id },
      { $set: { status: 'completed' }, $unset: { 'metadata.walletCredited': '' } },
    );

    const before = await Transaction.findById(rawTxn._id);
    expect(before?.status).toBe('completed');
    expect(before?.metadata?.walletCredited).toBeFalsy(); // sanity: no marker present

    // Send payment.captured webhook for the already-completed order
    await webhook('payment.captured', orderId, paymentId);

    const user = await User.findById(rawTxn.userId);
    // FINDING if balance !== 0: re-credited a legacy completed row (FIX A regression)
    expect(user?.walletBalance).toBe(0);

    // FINDING if called: analytics fired on an illegal re-credit
    expect(analyticsSpy).not.toHaveBeenCalled();

    // Transaction status must remain completed (not flipped back to pending/completed again)
    const after = await Transaction.findById(rawTxn._id);
    expect(after?.status).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // Test 5: Replay after completion — duplicate delivery of same event
  // -------------------------------------------------------------------------
  it('T5 duplicate payment.captured delivery → credited once (balance = 5), analytics = 1×', async () => {
    const orderId = 'order_t5_4ni';
    const paymentId = 'pay_t5_4ni';
    await seedUserAndPendingTxn(orderId, 5);

    // First delivery
    await webhook('payment.captured', orderId, paymentId);

    // Second identical delivery (replay / webhook retry)
    await webhook('payment.captured', orderId, paymentId);

    const txn = await Transaction.findOne({ razorpayOrderId: orderId });
    const user = await User.findById(txn?.userId);

    // FINDING if balance !== 5: replay double-credited
    expect(user?.walletBalance).toBe(5);
    // FINDING if 2: analytics fired on replay
    expect(analyticsSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 6: verify-payment idempotent after webhook already credited the order
  // -------------------------------------------------------------------------
  it('T6 verify-payment after webhook credit → no double-credit, responds 2xx (not 404/500)', async () => {
    const orderId = 'order_t6_4ni';
    const paymentId = 'pay_t6_4ni';
    const { user: rawUser, token } = await seedUserAndPendingTxn(orderId, 5);

    // Step 1: webhook credits the order
    await webhook('payment.captured', orderId, paymentId);

    const afterWebhook = await User.findById(rawUser._id);
    expect(afterWebhook?.walletBalance).toBe(5); // sanity

    analyticsSpy.mockClear(); // reset call count for the verify-payment phase

    // Step 2: verify-payment for the already-credited order
    const verifyRes = await verifyPayment(orderId, paymentId, token);

    // Must NOT blow up with 500, and must NOT silently 404 leaving the client confused
    // FINDING if 404: verify-payment doesn't handle "already processed" gracefully
    // FINDING if 500: unhandled error when order already completed
    expect(verifyRes.status).not.toBe(404);
    expect(verifyRes.status).not.toBe(500);

    const user = await User.findById(rawUser._id);
    // FINDING if balance !== 5: verify-payment double-credited after webhook
    expect(user?.walletBalance).toBe(5);

    // FINDING if called: analytics fired again on the idempotent verify path
    expect(analyticsSpy).not.toHaveBeenCalled();
  });
});
