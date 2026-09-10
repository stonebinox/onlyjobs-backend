/**
 * Adversarial integration tests — onlyjobs-7s3
 * Razorpay webhook HMAC raw-body verification
 *
 * Strategy: assume the implementation is subtly wrong; each test targets a distinct failure mode.
 * Failures are FINDINGS — do not modify production code to fix them.
 *
 * FORBIDDEN reads: walletController, razorpayService, index.ts, any existing test.
 * razorpayService.verifyWebhookSignature is NOT mocked — real HMAC is exercised.
 */

// Env vars must be set BEFORE any module that reads them is imported
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret-7s3-adversarial';
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy_key_id';
process.env.RAZORPAY_KEY_SECRET = 'test_dummy_key_secret';

import request from 'supertest';
import crypto from 'crypto';
import mongoose from 'mongoose';

// Import the REAL production app — tests now guard actual middleware wiring
import app from '../app';
import Transaction, { ITransaction } from '../models/Transaction';
import User from '../models/User';

// ─── constants ────────────────────────────────────────────────────────────────

const TEST_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET!;
const WEBHOOK_PATH = '/api/wallet/webhook';

// ─── helpers ──────────────────────────────────────────────────────────────────

function hmacHex(payload: string, secret: string = TEST_SECRET): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Send a webhook request with the x-razorpay-signature set from `secret`. */
function webhookRequest(body: string, secret: string = TEST_SECRET) {
  return request(app)
    .post(WEBHOOK_PATH)
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', hmacHex(body, secret))
    .send(body);
}

let userCounter = 0;

async function makeUser(walletBalance = 0) {
  userCounter++;
  return User.create({
    email: `adv7s3_${userCounter}@test.local`,
    password: 'hashed-pw-placeholder',
    walletBalance,
  });
}

async function makePendingTx(
  userId: mongoose.Types.ObjectId,
  razorpayOrderId: string,
  amount = 100
): Promise<ITransaction> {
  return Transaction.create({
    userId,
    type: 'credit',
    amount,
    description: 'Wallet top-up (test)',
    razorpayOrderId,
    status: 'pending',
  }) as unknown as ITransaction;
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe('7s3 — Razorpay webhook HMAC adversarial', () => {

  // ── Test 1: RAW-BYTES ──────────────────────────────────────────────────────
  // The core contract: HMAC is over the EXACT raw request bytes.
  // If the server re-serializes (JSON.stringify(req.body)) before hashing, the
  // signature it computes will not match ours — and it will reject a legitimately
  // signed request.  THIS TEST MUST FAIL if re-serialization is the bug.
  describe('Test 1 — RAW-BYTES: non-canonical body signed over exact bytes', () => {
    it('accepts a payment.captured body with extra spaces and non-alphabetical key order', async () => {
      const user = await makeUser(0);
      await makePendingTx(user._id, 'order_raw_bytes_1', 500);

      // Non-canonical: extra spaces around ":" and between tokens;
      // "payload" key appears BEFORE "event" so re-serialization changes key order.
      // JSON.stringify(JSON.parse(rawBody)) produces different bytes — the test
      // exposes any implementation that hashes req.body instead of req.rawBody.
      const rawBody =
        '{  "payload" :  {  "payment" :  {  "entity" :  ' +
        '{  "id" :  "pay_raw1",  "order_id" :  "order_raw_bytes_1"  }  }  },' +
        '  "event" :  "payment.captured"  }';

      const sig = hmacHex(rawBody); // HMAC over these exact bytes

      // Send the string directly so supertest does not re-encode it
      const res = await request(app)
        .post(WEBHOOK_PATH)
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', sig)
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: true });

      const tx = await Transaction.findOne({ razorpayOrderId: 'order_raw_bytes_1' });
      expect(tx?.status).toBe('completed');
    });
  });

  // ── Test 2: payment.failed — all contract fields persisted ────────────────
  describe('Test 2 — payment.failed: all contract fields are persisted', () => {
    it('sets status=failed and every metadata field when error_description is present', async () => {
      const user = await makeUser();
      await makePendingTx(user._id, 'order_fail_fields', 200);

      const body = JSON.stringify({
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_fail_1',
              order_id: 'order_fail_fields',
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Card declined by issuer',
              error_reason: 'payment_failed',
            },
          },
        },
      });

      const res = await webhookRequest(body);
      expect(res.status).toBe(200);

      const tx = await Transaction.findOne({ razorpayOrderId: 'order_fail_fields' });
      expect(tx).not.toBeNull();
      // Core status change (contract: "sets status:'failed'")
      expect(tx!.status).toBe('failed');
      // metadata.failureReason = error_description (contract: "= error_description … if absent: 'Payment failed'")
      expect(tx!.metadata?.failureReason).toBe('Card declined by issuer');
      // metadata.errorCode (contract: "errorCode")
      expect(tx!.metadata?.errorCode).toBe('BAD_REQUEST_ERROR');
      // metadata.errorReason (contract: "errorReason")
      expect(tx!.metadata?.errorReason).toBe('payment_failed');
      // metadata.cancelledBy (contract: "cancelledBy:'razorpay_webhook'")
      expect(tx!.metadata?.cancelledBy).toBe('razorpay_webhook');
      // metadata.webhookEvent (contract: "webhookEvent:'payment.failed'")
      expect(tx!.metadata?.webhookEvent).toBe('payment.failed');
      // metadata.failedAt (contract: "failedAt" — must be a date-like value)
      expect(tx!.metadata?.failedAt).toBeDefined();
    });

    it('falls back to "Payment failed" for failureReason when error_description is absent', async () => {
      const user = await makeUser();
      await makePendingTx(user._id, 'order_fail_no_desc', 150);

      const body = JSON.stringify({
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_fail_nodesc',
              order_id: 'order_fail_no_desc',
              // error_description deliberately absent
              error_code: 'GATEWAY_ERROR',
              error_reason: 'gateway_timeout',
            },
          },
        },
      });

      const res = await webhookRequest(body);
      expect(res.status).toBe(200);

      const tx = await Transaction.findOne({ razorpayOrderId: 'order_fail_no_desc' });
      expect(tx!.status).toBe('failed');
      // Contract: "or 'Payment failed' if absent"
      expect(tx!.metadata?.failureReason).toBe('Payment failed');
    });
  });

  // ── Test 3: Invalid signature → 400 + no mutation ─────────────────────────
  describe('Test 3 — invalid signature: 400 and transaction remains pending', () => {
    it('returns 400 and leaves transaction unchanged when a single hex char is flipped', async () => {
      const user = await makeUser();
      await makePendingTx(user._id, 'order_badsig', 300);

      const body = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: 'pay_badsig', order_id: 'order_badsig' } },
        },
      });

      const validSig = hmacHex(body);
      // Flip the very last hex character
      const lastChar = validSig.slice(-1);
      const flipped = validSig.slice(0, -1) + (lastChar === 'a' ? 'b' : 'a');

      const res = await request(app)
        .post(WEBHOOK_PATH)
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', flipped)
        .send(body);

      expect(res.status).toBe(400);

      const tx = await Transaction.findOne({ razorpayOrderId: 'order_badsig' });
      expect(tx?.status).toBe('pending');
    });
  });

  // ── Test 4: Missing signature header → 4xx + no mutation ─────────────────
  describe('Test 4 — missing signature header: rejected with 4xx', () => {
    it('returns 4xx and leaves transaction pending when x-razorpay-signature is absent', async () => {
      const user = await makeUser();
      await makePendingTx(user._id, 'order_nosig', 300);

      const body = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: 'pay_nosig', order_id: 'order_nosig' } },
        },
      });

      // Deliberately no x-razorpay-signature header
      const res = await request(app)
        .post(WEBHOOK_PATH)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);

      const tx = await Transaction.findOne({ razorpayOrderId: 'order_nosig' });
      expect(tx?.status).toBe('pending');
    });
  });

  // ── Test 5: SECURITY — forged capture with wrong secret ───────────────────
  // A forged payment.captured signed with an attacker-controlled secret must
  // NEVER credit the wallet.  This is the highest-stakes failure mode.
  describe('Test 5 — SECURITY: wrong-secret capture must not credit wallet', () => {
    it('returns 400 and leaves walletBalance unchanged when signed with the wrong secret', async () => {
      const user = await makeUser(50);
      await makePendingTx(user._id, 'order_forged', 1000);

      const body = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: 'pay_forged', order_id: 'order_forged' } },
        },
      });

      // Attacker signs with their own secret — not RAZORPAY_WEBHOOK_SECRET
      const res = await webhookRequest(body, 'attacker-controlled-wrong-secret');

      expect(res.status).toBe(400);

      const updatedUser = await User.findById(user._id);
      expect(updatedUser?.walletBalance).toBe(50); // must be unchanged

      const tx = await Transaction.findOne({ razorpayOrderId: 'order_forged' });
      expect(tx?.status).toBe('pending'); // must not be completed
    });
  });

  // ── Test 6: Idempotent credit — replay must not double-credit ─────────────
  // metadata.walletCredited guards against double credit.
  // Replaying the same validly-signed event must credit only once.
  describe('Test 6 — idempotent credit: wallet credited exactly once across replays', () => {
    it('credits wallet once on first delivery and ignores the duplicate on replay', async () => {
      const user = await makeUser(0);
      await makePendingTx(user._id, 'order_idempotent', 250);

      const body = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: { id: 'pay_idempotent', order_id: 'order_idempotent' },
          },
        },
      });

      // First delivery
      const res1 = await webhookRequest(body);
      expect(res1.status).toBe(200);
      expect(res1.body).toMatchObject({ received: true });

      const userAfterFirst = await User.findById(user._id);
      expect(userAfterFirst?.walletBalance).toBe(250);

      const txAfterFirst = await Transaction.findOne({ razorpayOrderId: 'order_idempotent' });
      expect(txAfterFirst?.status).toBe('completed');
      // Guard flag must be set so the second delivery can detect a replay
      expect(txAfterFirst?.metadata?.walletCredited).toBe(true);

      // Second delivery — identical payload, identical signature
      const res2 = await webhookRequest(body);
      expect(res2.status).toBe(200); // still acks

      const userAfterSecond = await User.findById(user._id);
      // Contract: "exactly once" — walletBalance must NOT double
      expect(userAfterSecond?.walletBalance).toBe(250); // NOT 500
    });
  });

  // ── Test 7: payment.failed must not downgrade a completed transaction ──────
  // A late-arriving payment.failed for an already-completed order must not
  // overwrite status='completed' with status='failed'.
  describe('Test 7 — no downgrade: payment.failed leaves completed transaction unchanged', () => {
    it('keeps status=completed when payment.failed arrives for an already-completed transaction', async () => {
      const user = await makeUser(100);

      const tx = await Transaction.create({
        userId: user._id,
        type: 'credit',
        amount: 100,
        description: 'Wallet top-up (already done)',
        razorpayOrderId: 'order_already_complete',
        status: 'completed',
        metadata: { walletCredited: true, webhookEvent: 'payment.captured' },
      });

      const body = JSON.stringify({
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_late_fail',
              order_id: 'order_already_complete',
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Duplicate or expired',
              error_reason: 'payment_failed',
            },
          },
        },
      });

      const res = await webhookRequest(body);
      // Server must still ack 200 (Razorpay will retry if it gets non-200)
      expect(res.status).toBe(200);

      const updatedTx = await Transaction.findById(tx._id);
      // Contract: "Does NOT match/alter a non-pending transaction
      //            (never downgrades a 'completed' one)"
      expect(updatedTx?.status).toBe('completed');
    });
  });

  // ── Test 8: unknown event type → 200 ack, no mutation ────────────────────
  // Contract: "unknown event types → 200 ack, no DB mutation"
  describe('Test 8 — unknown event: 200 ack with no DB side effects', () => {
    it('returns 200 and makes no changes to transaction or wallet for an unrecognised event', async () => {
      const user = await makeUser(75);
      const tx = await makePendingTx(user._id, 'order_unknown_event', 100);

      const body = JSON.stringify({
        event: 'refund.created', // not handled by the webhook
        payload: {
          payment: {
            entity: { id: 'pay_unknown', order_id: 'order_unknown_event' },
          },
        },
      });

      const res = await webhookRequest(body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: true });

      // No wallet change
      const updatedUser = await User.findById(user._id);
      expect(updatedUser?.walletBalance).toBe(75);

      // No transaction change
      const updatedTx = await Transaction.findById(tx._id);
      expect(updatedTx?.status).toBe('pending');
    });
  });
});
