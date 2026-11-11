// 6a4p Phase 4 fix-pass tests. Oracle = fix-pass requirements F5, F7, F8, F9, F10.
process.env.JWT_SECRET = 'test-jwt-secret-6a4p';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret-6a4p';
process.env.RAZORPAY_KEY_SECRET = 'test-key-secret-6a4p';
process.env.RAZORPAY_KEY_ID = 'test-key-id-6a4p';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn().mockReturnValue({}) }));
jest.mock('bcrypt', () => ({
  hash: (pw: string) => Promise.resolve(`hashed_${pw}`),
  compare: (pw: string, h: string) => Promise.resolve(h === `hashed_${pw}`),
}));
jest.mock('../services/emailService', () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(true),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/matchingService');

import request from 'supertest';
import {
  app, metaOn, saveMetaEnv, restoreMetaEnv, mkUser, mkPendingTxn, verifyReq, signupReq, outboxRows,
  User, MetaEventOutbox, GO_LIVE,
} from './6a4p.helpers';
import MatchRecord from '../models/MatchRecord';
import JobListing from '../models/JobListing';
import { enqueueMetaEvent, sanitizeMetaClick } from '../utils/metaEvents';
import { resolveMetaWorkerConfig } from '../services/metaCapi';
import { hasVisibleBriefMatch } from '../utils/todayEligibility';
import { reconcileMetaEvents } from '../services/metaReconciler';

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

beforeAll(async () => {
  await MetaEventOutbox.syncIndexes();
});
beforeEach(() => {
  saveMetaEnv();
  metaOn();
});
afterEach(() => {
  restoreMetaEnv();
  jest.restoreAllMocks();
});

const baseEvent = (over: Record<string, unknown> = {}) => ({
  eventId: `reg_fix_${Math.random()}`,
  eventName: 'CompleteRegistration' as const,
  eventTime: Math.floor(Date.now() / 1000),
  userId: '64b000000000000000000001',
  userData: {},
  ...over,
});

describe('F8/F9 enqueueMetaEvent enforces the gate itself', () => {
  it('disabled flag -> false and no row', async () => {
    process.env.META_CAPI_ENABLED = 'false';
    expect(await enqueueMetaEvent(baseEvent())).toBe(false);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('unset / invalid START_AT -> false and no row', async () => {
    delete process.env.META_CAPI_START_AT;
    expect(await enqueueMetaEvent(baseEvent())).toBe(false);
    process.env.META_CAPI_START_AT = 'garbage';
    expect(await enqueueMetaEvent(baseEvent())).toBe(false);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('event one second before START_AT -> false; at START_AT -> true', async () => {
    const start = Math.floor(Date.now() / 1000) - 3600;
    process.env.META_CAPI_START_AT = new Date(start * 1000).toISOString();
    expect(await enqueueMetaEvent(baseEvent({ eventId: 'reg_before', eventTime: start - 1 }))).toBe(false);
    expect(await enqueueMetaEvent(baseEvent({ eventId: 'reg_at', eventTime: start }))).toBe(true);
    const rows = await outboxRows();
    expect(rows.map((r) => r.eventId)).toEqual(['reg_at']);
  });
});

describe('F9 START_AT in the future enqueues nothing', () => {
  beforeEach(() => {
    process.env.META_CAPI_START_AT = FUTURE;
  });

  it('live signup', async () => {
    const res = await signupReq({ email: `future-${Math.random()}@example.com`, password: 'pw12345678' });
    expect(res.status).toBeLessThan(300);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('live credit (verify-payment)', async () => {
    const { user, token } = await mkUser();
    await mkPendingTxn(user._id, 'order_future', 10);
    const res = await verifyReq('order_future', 'pay_future', token);
    expect(res.status).toBe(200);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('live activation', async () => {
    const { user, token } = await mkUser();
    const job: any = await JobListing.create({
      title: 'J', company: 'C', location: ['Remote'], source: 'test', description: 'd',
      url: `https://example.com/jobs/future-${Date.now()}`,
    });
    await MatchRecord.create({
      userId: user._id, jobId: job._id, matchScore: 80, verdict: 'ok', reasoning: 'r',
      skipped: false, clicked: false, applied: null,
    } as any);
    const res = await request(app)
      .post('/api/matches/activation')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('reconciler', async () => {
    await mkUser();
    await reconcileMetaEvents();
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('F9 pre-START_AT conversions never enqueue (live path)', () => {
  it('purchase credited before START_AT -> no row', async () => {
    const { user, token } = await mkUser();
    process.env.META_CAPI_START_AT = new Date(Date.now() + 60_000).toISOString();
    await mkPendingTxn(user._id, 'order_pre', 10);
    await verifyReq('order_pre', 'pay_pre', token);
    expect(await outboxRows({ eventName: 'Purchase' })).toHaveLength(0);
  });
});

describe('F7 META_GRAPH_API_VERSION format', () => {
  const setAll = (version: string | undefined) => {
    process.env.META_CAPI_START_AT = GO_LIVE;
    process.env.META_PIXEL_ID = '123';
    process.env.META_CAPI_ACCESS_TOKEN = 'tok';
    if (version === undefined) delete process.env.META_GRAPH_API_VERSION;
    else process.env.META_GRAPH_API_VERSION = version;
  };

  it.each(['v19.0', 'v21.0', 'v100.12'])('accepts %s', (v) => {
    setAll(v);
    expect(resolveMetaWorkerConfig().ok).toBe(true);
  });

  it.each(['19.0', 'v19', 'v19.0/../x', 'v19.0?a=b', 'v19.0 ', ' v19.0', 'V19.0', 'v19.0.1', 'v.0', ''])(
    'rejects %j',
    (v) => {
      setAll(v);
      expect(resolveMetaWorkerConfig().ok).toBe(false);
    }
  );

  it('rejects unset', () => {
    setAll(undefined);
    expect(resolveMetaWorkerConfig().ok).toBe(false);
  });
});

describe('F5 a 512-char fbclid survives sanitizeMetaClick', () => {
  const fbclid = 'A'.repeat(512);
  const fbc = `fb.1.1700000000000.${fbclid}`;

  it('keeps fbclid(512) and the fbc built from it', () => {
    expect(sanitizeMetaClick({ fbclid, fbc })).toEqual({ fbclid, fbc });
  });

  it('rejects fbclid of 513 chars', () => {
    expect(sanitizeMetaClick({ fbclid: 'A'.repeat(513) })).toBeUndefined();
  });

  it('rejects fbc/fbp over 600 chars', () => {
    const long = `fb.1.1.${'A'.repeat(600)}`;
    expect(sanitizeMetaClick({ fbc: long, fbp: long })).toBeUndefined();
  });
});

describe('F10 hasVisibleBriefMatch 15-day window matches the /today brief (createdAt >= now - 15d)', () => {
  // Fixed instant in a DST-free span for common zones; window uses calendar-day arithmetic.
  const now = new Date('2026-07-01T12:00:00.000Z');
  const edge = new Date(now.getTime());
  edge.setDate(edge.getDate() - 15);

  async function matchAt(userId: unknown, createdAt: Date) {
    const job: any = await JobListing.create({
      title: 'J', company: 'C', location: ['Remote'], source: 'test', description: 'd',
      url: `https://example.com/jobs/edge-${Math.random()}`,
    });
    const rec: any = await MatchRecord.create({
      userId, jobId: job._id, matchScore: 80, verdict: 'ok', reasoning: 'r',
      skipped: false, clicked: false, applied: null,
    } as any);
    await MatchRecord.collection.updateOne({ _id: rec._id }, { $set: { createdAt } });
  }

  it('exactly 15 days old is included', async () => {
    const { user } = await mkUser();
    await matchAt(user._id, edge);
    expect(await hasVisibleBriefMatch(user._id, 30, now)).toBe(true);
  });

  it('15 days + 1ms old is excluded', async () => {
    const { user } = await mkUser();
    await matchAt(user._id, new Date(edge.getTime() - 1));
    expect(await hasVisibleBriefMatch(user._id, 30, now)).toBe(false);
  });

  it('15 days - 1ms old is included', async () => {
    const { user } = await mkUser();
    await matchAt(user._id, new Date(edge.getTime() + 1));
    expect(await hasVisibleBriefMatch(user._id, 30, now)).toBe(true);
  });
});
