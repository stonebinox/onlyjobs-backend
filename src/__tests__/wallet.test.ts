jest.mock('../services/razorpayService', () => ({
  createOrder: jest.fn(),
  verifyPayment: jest.fn(),
  verifyWebhookSignature: jest.fn(),
  fetchOrder: jest.fn(),
}));

jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { createOrder, verifyPayment } from '../services/razorpayService';
import walletRoutes from '../routes/walletRoutes';

const mockCreateOrder = createOrder as jest.Mock;
const mockVerifyPayment = verifyPayment as jest.Mock;

let testUserId: mongoose.Types.ObjectId;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.user = { _id: testUserId };
  next();
});
testApp.use('/api/wallet', walletRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

beforeEach(() => {
  testUserId = new mongoose.Types.ObjectId();
  mockCreateOrder.mockClear();
  mockVerifyPayment.mockClear();
});

async function createUser(walletBalance = 0) {
  return User.create({
    _id: testUserId,
    name: 'Test User',
    email: `test-${Date.now()}-${Math.random()}@example.com`,
    password: 'hashed',
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
    walletBalance,
  });
}

// ---------------------------------------------------------------------------
// GET /api/wallet/balance
// ---------------------------------------------------------------------------

describe('GET /api/wallet/balance', () => {
  it('returns 404 when user does not exist', async () => {
    const res = await request(testApp).get('/api/wallet/balance');
    expect(res.status).toBe(404);
  });

  it('returns wallet balance for authenticated user', async () => {
    await createUser(42.50);

    const res = await request(testApp).get('/api/wallet/balance');
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(42.50);
  });

  it('returns 0 when user has no balance', async () => {
    await createUser(0);

    const res = await request(testApp).get('/api/wallet/balance');
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/wallet/create-order
// ---------------------------------------------------------------------------

describe('POST /api/wallet/create-order', () => {
  it('returns 400 when amount is missing', async () => {
    const res = await request(testApp).post('/api/wallet/create-order').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is 0', async () => {
    const res = await request(testApp).post('/api/wallet/create-order').send({ amount: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when amount exceeds 500', async () => {
    const res = await request(testApp).post('/api/wallet/create-order').send({ amount: 501 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when amount has decimals', async () => {
    const res = await request(testApp).post('/api/wallet/create-order').send({ amount: 9.99 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is a string', async () => {
    const res = await request(testApp).post('/api/wallet/create-order').send({ amount: '10' });
    expect(res.status).toBe(400);
  });

  it('creates a payment order and pending transaction', async () => {
    mockCreateOrder.mockResolvedValue({
      id: 'order_abc123',
      amount: 1000,
      currency: 'USD',
      status: 'created',
    });

    const res = await request(testApp).post('/api/wallet/create-order').send({ amount: 10 });

    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe('order_abc123');
    expect(res.body.amount).toBe(10); // 1000 cents → $10
    expect(res.body.currency).toBe('USD');

    const tx = await Transaction.findOne({ razorpayOrderId: 'order_abc123' });
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe('pending');
    expect(tx!.amount).toBe(10);
    expect(tx!.type).toBe('credit');
  });

  it('returns 500 when Razorpay order creation fails', async () => {
    mockCreateOrder.mockRejectedValue(new Error('Razorpay error'));

    const res = await request(testApp).post('/api/wallet/create-order').send({ amount: 10 });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/wallet/verify-payment
// ---------------------------------------------------------------------------

describe('POST /api/wallet/verify-payment', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(testApp)
      .post('/api/wallet/verify-payment')
      .send({ orderId: 'order_123' }); // missing paymentId and signature
    expect(res.status).toBe(400);
  });

  it('returns 400 when signature is invalid', async () => {
    mockVerifyPayment.mockReturnValue(false);

    const res = await request(testApp).post('/api/wallet/verify-payment').send({
      orderId: 'order_123',
      paymentId: 'pay_123',
      signature: 'bad_sig',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid payment signature/i);
  });

  it('returns 404 when no matching pending transaction exists', async () => {
    mockVerifyPayment.mockReturnValue(true);

    const res = await request(testApp).post('/api/wallet/verify-payment').send({
      orderId: 'order_nonexistent',
      paymentId: 'pay_123',
      signature: 'valid_sig',
    });
    expect(res.status).toBe(404);
  });

  it('credits wallet and marks transaction completed on valid payment', async () => {
    await createUser(5);
    await Transaction.create({
      userId: testUserId,
      type: 'credit',
      amount: 20,
      description: 'Wallet top-up - $20',
      razorpayOrderId: 'order_valid',
      status: 'pending',
    });

    mockVerifyPayment.mockReturnValue(true);

    const res = await request(testApp).post('/api/wallet/verify-payment').send({
      orderId: 'order_valid',
      paymentId: 'pay_valid',
      signature: 'valid_sig',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.newBalance).toBe(25); // 5 + 20

    const updatedUser = await User.findById(testUserId);
    expect(updatedUser!.walletBalance).toBe(25);

    const updatedTx = await Transaction.findOne({ razorpayOrderId: 'order_valid' });
    expect(updatedTx!.status).toBe('completed');
    expect(updatedTx!.razorpayPaymentId).toBe('pay_valid');
  });
});

// ---------------------------------------------------------------------------
// GET /api/wallet/transactions
// ---------------------------------------------------------------------------

describe('GET /api/wallet/transactions', () => {
  it('returns empty list when user has no transactions', async () => {
    const res = await request(testApp).get('/api/wallet/transactions');
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it('returns transactions for authenticated user only', async () => {
    const otherId = new mongoose.Types.ObjectId();
    await Transaction.create({
      userId: testUserId,
      type: 'credit',
      amount: 10,
      description: 'Top-up',
      status: 'completed',
    });
    await Transaction.create({
      userId: otherId,
      type: 'credit',
      amount: 50,
      description: 'Other user top-up',
      status: 'completed',
    });

    const res = await request(testApp).get('/api/wallet/transactions');
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it('respects pagination parameters', async () => {
    for (let i = 0; i < 5; i++) {
      await Transaction.create({
        userId: testUserId,
        type: 'debit',
        amount: 0.3,
        description: `Matching charge ${i}`,
        status: 'completed',
      });
    }

    const res = await request(testApp).get('/api/wallet/transactions?page=1&limit=3');
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(3);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.totalPages).toBe(2);
  });
});
