// Shared helpers for the 6a4p adversarial suites. Test-only; no production imports of
// forbidden implementation files other than as black boxes (model + public exports).
// NOTE: env vars used by app/jwt/razorpay MUST be set by the importing test file BEFORE it
// imports this module (see top of each test file).
import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../app';
import User from '../models/User';
import Transaction from '../models/Transaction';
import MetaEventOutbox from '../models/MetaEventOutbox';

export const WEBHOOK_SECRET = 'test-webhook-secret-6a4p';
export const KEY_SECRET = 'test-key-secret-6a4p';
export const JWT_SECRET = 'test-jwt-secret-6a4p';
export const DAY = 24 * 60 * 60 * 1000;
export const GO_LIVE = '2026-01-01T00:00:00.000Z';

const META_ENV = [
  'META_CAPI_ENABLED',
  'META_CAPI_START_AT',
  'META_PIXEL_ID',
  'META_CAPI_ACCESS_TOKEN',
  'META_GRAPH_API_VERSION',
  'META_TEST_EVENT_CODE',
  'SITE_URL',
];
let saved: Record<string, string | undefined> = {};
export function saveMetaEnv() {
  saved = {};
  for (const k of META_ENV) saved[k] = process.env[k];
}
export function restoreMetaEnv() {
  for (const k of META_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
export function metaOn(startAt: string = GO_LIVE) {
  process.env.META_CAPI_ENABLED = 'true';
  process.env.META_CAPI_START_AT = startAt;
  process.env.SITE_URL = 'https://onlyjobs.example.com';
}
export function metaOff() {
  delete process.env.META_CAPI_ENABLED;
  delete process.env.META_CAPI_START_AT;
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let seq = 0;
export const nextSeq = () => ++seq;
export const uniqueIp = () => `10.${(seq >> 8) & 255}.${seq & 255}.${(Math.random() * 250 + 1) | 0}`;

export function tokenFor(id: unknown) {
  return jwt.sign({ id: String(id) }, JWT_SECRET, { expiresIn: '30d' });
}

export const RESUME = {
  skills: ['typescript'],
  experience: ['Built things at Acme'],
  education: [],
  summary: 'Senior engineer with ten years of experience',
  certifications: [],
  languages: [],
  projects: [],
  achievements: [],
  volunteerExperience: [],
  interests: [],
};
export const EMPTY_RESUME = {
  skills: [],
  experience: [],
  education: [],
  summary: '   ',
  certifications: [],
  languages: [],
  projects: [],
  achievements: [],
  volunteerExperience: [],
  interests: [],
};

export async function mkUser(extra: Record<string, any> = {}) {
  const n = nextSeq();
  const user: any = await User.create({
    email: `6a4p-${n}-${Date.now()}@example.com`,
    password: 'hashed-pw',
    walletBalance: 0,
    isVerified: true,
    resume: RESUME,
    ...extra,
  });
  return { user, token: tokenFor(user._id) };
}

export async function setUserCreatedAt(userId: unknown, d: Date) {
  await User.collection.updateOne({ _id: userId as any }, { $set: { createdAt: d } });
}

export async function mkPendingTxn(
  userId: unknown,
  orderId: string,
  amount = 10,
  metadata: Record<string, any> = {}
) {
  return Transaction.create({
    userId,
    type: 'credit',
    amount,
    description: 'Wallet top-up',
    razorpayOrderId: orderId,
    status: 'pending',
    metadata,
  } as any) as any;
}

export const signVerify = (orderId: string, paymentId: string) =>
  crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

export function verifyReq(orderId: string, paymentId: string, token: string) {
  return request(app)
    .post('/api/wallet/verify-payment')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId, paymentId, signature: signVerify(orderId, paymentId) });
}

export function webhookReq(
  event: 'payment.captured' | 'order.paid' | 'payment.failed',
  orderId: string,
  paymentId: string
) {
  const extras =
    event === 'payment.failed'
      ? { error_code: 'BAD_REQUEST_ERROR', error_description: 'declined', error_reason: 'payment_failed' }
      : {};
  const body = JSON.stringify({
    event,
    payload: {
      payment: { entity: { id: paymentId, order_id: orderId, ...extras } },
      order: { entity: { id: orderId } },
    },
  });
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  return request(app)
    .post('/api/wallet/webhook')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', sig)
    .send(body);
}

export function syncReq(orderId: string, token: string) {
  return request(app).get(`/api/wallet/sync/${orderId}`).set('Authorization', `Bearer ${token}`);
}

export function signupReq(body: Record<string, any>) {
  return request(app).post('/api/users/auth').set('X-Forwarded-For', uniqueIp()).send(body);
}

export const outboxRows = (filter: Record<string, any> = {}) =>
  MetaEventOutbox.find(filter).lean() as unknown as Promise<any[]>;

/**
 * Make every plausible MetaEventOutbox write path reject. Returns { calls(), restore() }.
 * calls() lets a test assert the break was actually exercised (otherwise the test proves nothing).
 */
export function breakOutbox() {
  const spies: jest.SpyInstance[] = [];
  const boom = () => Promise.reject(new Error('simulated outbox failure'));
  const M: any = MetaEventOutbox;
  for (const m of ['create', 'insertMany', 'updateOne', 'findOneAndUpdate', 'bulkWrite', 'replaceOne', 'updateMany']) {
    if (typeof M[m] === 'function') spies.push(jest.spyOn(M, m).mockImplementation(boom as any));
  }
  const C: any = MetaEventOutbox.collection;
  for (const m of ['insertOne', 'insertMany', 'updateOne', 'findOneAndUpdate', 'bulkWrite', 'replaceOne', 'updateMany']) {
    if (typeof C[m] === 'function') spies.push(jest.spyOn(C, m).mockImplementation(boom as any));
  }
  const saveSpy = jest.spyOn(M.prototype, 'save').mockImplementation(boom as any);
  spies.push(saveSpy);
  return {
    calls: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

export { app, mongoose, request, User, Transaction, MetaEventOutbox };
