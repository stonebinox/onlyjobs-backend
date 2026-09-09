jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import Transaction from '../models/Transaction';
import walletRoutes from '../routes/walletRoutes';

let testUserId: mongoose.Types.ObjectId;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.user = { _id: testUserId };
  next();
});
testApp.use('/api/wallet', walletRoutes);

beforeEach(() => {
  testUserId = new mongoose.Types.ObjectId();
});

async function seedPendingTx(orderId: string, userId = testUserId, amount = 10) {
  return Transaction.create({
    userId,
    type: 'credit',
    amount,
    description: `Wallet top-up - $${amount}`,
    razorpayOrderId: orderId,
    status: 'pending',
  });
}

// ---------------------------------------------------------------------------
// POST /api/wallet/payment-failed — client failure persistence
// ---------------------------------------------------------------------------

describe('POST /api/wallet/payment-failed — client failure persistence', () => {
  it('records status=failed and metadata on a pending transaction', async () => {
    await seedPendingTx('order_fail_001');

    const res = await request(testApp)
      .post('/api/wallet/payment-failed')
      .send({
        orderId: 'order_fail_001',
        errorCode: 'BAD_REQUEST_ERROR',
        errorDescription: 'Card declined by bank',
        errorReason: 'payment_failed',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_fail_001' });
    expect(tx!.status).toBe('failed');
    expect(tx!.metadata!.errorCode).toBe('BAD_REQUEST_ERROR');
    expect(tx!.metadata!.errorReason).toBe('payment_failed');
    expect(tx!.metadata!.failureReason).toBe('Card declined by bank');
    expect(tx!.metadata!.cancelledBy).toBe('razorpay_client');
  });

  it('idempotency — posting payment-failed for a completed transaction does NOT downgrade it', async () => {
    await Transaction.create({
      userId: testUserId,
      type: 'credit',
      amount: 10,
      description: 'Top-up',
      razorpayOrderId: 'order_already_complete',
      status: 'completed',
    });

    const res = await request(testApp)
      .post('/api/wallet/payment-failed')
      .send({
        orderId: 'order_already_complete',
        errorCode: 'X',
        errorDescription: 'Late failure',
        errorReason: 'late',
      });

    expect(res.status).toBe(200);

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_already_complete' });
    expect(tx!.status).toBe('completed');
  });

  it('cross-user safety — another user cannot mark a transaction as failed', async () => {
    const otherUserId = new mongoose.Types.ObjectId();
    await seedPendingTx('order_cross_fail', testUserId);

    const otherApp = express();
    otherApp.use(express.json());
    otherApp.use((req: any, _res: any, next: any) => { req.user = { _id: otherUserId }; next(); });
    otherApp.use('/api/wallet', walletRoutes);

    const res = await request(otherApp)
      .post('/api/wallet/payment-failed')
      .send({ orderId: 'order_cross_fail', errorCode: 'X', errorDescription: 'D', errorReason: 'R' });

    expect(res.status).toBe(200);

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_cross_fail' });
    expect(tx!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// POST /api/wallet/record-failure-attempt — non-terminal attempt capture
// ---------------------------------------------------------------------------

describe('POST /api/wallet/record-failure-attempt — non-terminal failure capture', () => {
  it('records lastFailure metadata but leaves status=pending', async () => {
    await seedPendingTx('order_attempt_001');

    const res = await request(testApp)
      .post('/api/wallet/record-failure-attempt')
      .send({
        orderId: 'order_attempt_001',
        errorCode: 'BAD_REQUEST_ERROR',
        errorDescription: 'Card declined by bank',
        errorReason: 'payment_failed',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_attempt_001' });
    expect(tx!.status).toBe('pending');
    expect(tx!.metadata!.lastFailure.errorCode).toBe('BAD_REQUEST_ERROR');
    expect(tx!.metadata!.lastFailure.errorReason).toBe('payment_failed');
    expect(tx!.metadata!.lastFailure.errorDescription).toBe('Card declined by bank');
    expect(tx!.metadata!.lastFailure.at).toBeDefined();
    expect(tx!.metadata!.failedAttempts).toBe(1);
  });

  it('increments failedAttempts on a second call — still pending', async () => {
    await seedPendingTx('order_attempt_002');

    await request(testApp)
      .post('/api/wallet/record-failure-attempt')
      .send({ orderId: 'order_attempt_002', errorCode: 'E1', errorDescription: 'D1', errorReason: 'R1' });

    await request(testApp)
      .post('/api/wallet/record-failure-attempt')
      .send({ orderId: 'order_attempt_002', errorCode: 'E2', errorDescription: 'D2', errorReason: 'R2' });

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_attempt_002' });
    expect(tx!.status).toBe('pending');
    expect(tx!.metadata!.failedAttempts).toBe(2);
    expect(tx!.metadata!.lastFailure.errorCode).toBe('E2');
  });

  it('is retry-safe: transaction stays pending and creditable after record-failure-attempt', async () => {
    await seedPendingTx('order_attempt_retry');

    await request(testApp)
      .post('/api/wallet/record-failure-attempt')
      .send({ orderId: 'order_attempt_retry', errorCode: 'X', errorDescription: 'D', errorReason: 'R' });

    // Confirm transaction is still findable as pending (the query the credit path uses)
    const tx = await Transaction.findOne({
      razorpayOrderId: 'order_attempt_retry',
      status: 'pending',
    });
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe('pending');
  });

  it('returns benign success when transaction not found (already completed or wrong user)', async () => {
    const res = await request(testApp)
      .post('/api/wallet/record-failure-attempt')
      .send({ orderId: 'order_no_such', errorCode: 'X', errorDescription: 'D', errorReason: 'R' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 when orderId is missing', async () => {
    const res = await request(testApp)
      .post('/api/wallet/record-failure-attempt')
      .send({ errorCode: 'X' });

    expect(res.status).toBe(400);
  });

  it('cross-user — another user cannot record a failure attempt on this transaction', async () => {
    const otherUserId = new mongoose.Types.ObjectId();
    await seedPendingTx('order_attempt_cross', testUserId);

    const otherApp = express();
    otherApp.use(express.json());
    otherApp.use((req: any, _res: any, next: any) => { req.user = { _id: otherUserId }; next(); });
    otherApp.use('/api/wallet', walletRoutes);

    const res = await request(otherApp)
      .post('/api/wallet/record-failure-attempt')
      .send({ orderId: 'order_attempt_cross', errorCode: 'X', errorDescription: 'D', errorReason: 'R' });

    expect(res.status).toBe(200);

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_attempt_cross' });
    expect(tx!.status).toBe('pending');
    expect(tx!.metadata?.failedAttempts).toBeUndefined();
  });

  it('preserves existing metadata keys (e.g. orderDetails) when merging lastFailure', async () => {
    const tx = await seedPendingTx('order_attempt_preserve');
    tx.metadata = { orderDetails: { originalAmount: 10, currency: 'USD' } };
    await tx.save();

    await request(testApp)
      .post('/api/wallet/record-failure-attempt')
      .send({ orderId: 'order_attempt_preserve', errorCode: 'X', errorDescription: 'D', errorReason: 'R' });

    const updated = await Transaction.findOne({ razorpayOrderId: 'order_attempt_preserve' });
    expect(updated!.metadata!.orderDetails).toEqual({ originalAmount: 10, currency: 'USD' });
    expect(updated!.metadata!.lastFailure.errorCode).toBe('X');
  });
});

// ---------------------------------------------------------------------------
// POST /api/wallet/cancel-order — client cancellation persistence
// ---------------------------------------------------------------------------

describe('POST /api/wallet/cancel-order — client cancellation persistence', () => {
  it('records status=failed and metadata.cancelledBy=client', async () => {
    await seedPendingTx('order_cancel_001');

    const res = await request(testApp)
      .post('/api/wallet/cancel-order')
      .send({ orderId: 'order_cancel_001', reason: 'User closed modal' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_cancel_001' });
    expect(tx!.status).toBe('failed');
    expect(tx!.metadata!.cancelledBy).toBe('client');
    expect(tx!.metadata!.failureReason).toBe('User closed modal');
  });

  it('idempotency — cancelling a completed transaction does NOT downgrade it', async () => {
    await Transaction.create({
      userId: testUserId,
      type: 'credit',
      amount: 10,
      description: 'Top-up',
      razorpayOrderId: 'order_cancel_complete',
      status: 'completed',
    });

    const res = await request(testApp)
      .post('/api/wallet/cancel-order')
      .send({ orderId: 'order_cancel_complete', reason: 'late cancel' });

    expect(res.status).toBe(200);

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_cancel_complete' });
    expect(tx!.status).toBe('completed');
  });

  it('cross-user safety — another user cannot cancel a transaction', async () => {
    const otherUserId2 = new mongoose.Types.ObjectId();
    await seedPendingTx('order_cross_cancel', testUserId);

    const otherApp2 = express();
    otherApp2.use(express.json());
    otherApp2.use((req: any, _res: any, next: any) => { req.user = { _id: otherUserId2 }; next(); });
    otherApp2.use('/api/wallet', walletRoutes);

    await request(otherApp2)
      .post('/api/wallet/cancel-order')
      .send({ orderId: 'order_cross_cancel', reason: 'cross user cancel' });

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_cross_cancel' });
    expect(tx!.status).toBe('pending');
  });
});
