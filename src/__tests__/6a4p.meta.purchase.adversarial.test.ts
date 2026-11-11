// 6a4p adversarial: S3 Purchase, S4 user_data fallback, S7 create-order metaClick, S1 (credit path).
// Oracle = bd task requirements only. Implementation bodies were not read.
process.env.JWT_SECRET = 'test-jwt-secret-6a4p';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret-6a4p';
process.env.RAZORPAY_KEY_SECRET = 'test-key-secret-6a4p';
process.env.RAZORPAY_KEY_ID = 'test-key-id-6a4p';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn().mockReturnValue({}) }));
jest.mock('../services/emailService', () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(true),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(true),
}));
// Real HMAC verification is kept; only the outbound Razorpay API calls are stubbed.
jest.mock('../services/razorpayService', () => {
  const actual = jest.requireActual('../services/razorpayService');
  return { ...actual, createOrder: jest.fn(), fetchOrder: jest.fn() };
});

import request from 'supertest';
import {
  app, metaOn, metaOff, saveMetaEnv, restoreMetaEnv, mkUser, mkPendingTxn, verifyReq, webhookReq, syncReq,
  outboxRows, breakOutbox, sha256, User, Transaction, MetaEventOutbox, DAY, tokenFor,
} from './6a4p.helpers';
import { createOrder, fetchOrder } from '../services/razorpayService';
import { creditTransactionOnce } from '../utils/creditWallet';
import { reconcileMetaEvents } from '../services/metaReconciler';

const mockCreateOrder = createOrder as jest.Mock;
const mockFetchOrder = fetchOrder as jest.Mock;
const FBC = 'fb.1.1700000000000.AbCdEf123';
const FBP = 'fb.1.1700000000000.1234567890';
const FBC_USER = 'fb.1.1600000000000.UserAttrFbc';

beforeAll(async () => {
  await MetaEventOutbox.syncIndexes();
});
beforeEach(() => {
  saveMetaEnv();
  metaOn();
  mockCreateOrder.mockReset();
  mockFetchOrder.mockReset();
});
afterEach(() => {
  restoreMetaEnv();
  jest.restoreAllMocks();
});

const purchaseRows = () => outboxRows({ eventName: 'Purchase' });

describe('S3 Purchase: exactly one row per credited top-up, any path', () => {
  it('verify-payment: one row, value in DOLLARS (10 not 1000), USD, eventTime = walletCreditedAt secs; response carries ids', async () => {
    const { user, token } = await mkUser();
    const txn = await mkPendingTxn(user._id, 'order_v1', 10);
    const res = await verifyReq('order_v1', 'pay_v1', token);
    expect(res.status).toBe(200);
    expect(res.body.metaEventId).toBe(`purchase_${txn._id}`);
    expect(res.body.value).toBe(10);
    expect(res.body.currency).toBe('USD');
    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(`purchase_${txn._id}`);
    expect(rows[0].value).toBe(10);
    expect(rows[0].currency).toBe('USD');
    expect(String(rows[0].userId)).toBe(String(user._id));
    const fresh: any = await Transaction.findById(txn._id).lean();
    expect(fresh.metadata.walletCredited).toBe(true);
    expect(rows[0].eventTime).toBe(Math.floor(new Date(fresh.metadata.walletCreditedAt).getTime() / 1000));
    expect(String(rows[0].eventTime)).toMatch(/^\d{10}$/);
    expect((await User.findById(user._id).lean() as any).walletBalance).toBe(10);
  });

  it.each([5, 25, 100, 500])('value equals the dollar amount for a $%i top-up', async (amt) => {
    const { user, token } = await mkUser();
    await mkPendingTxn(user._id, `order_amt_${amt}`, amt);
    const res = await verifyReq(`order_amt_${amt}`, `pay_${amt}`, token);
    expect(res.body.value).toBe(amt);
    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(amt);
  });

  it.each(['payment.captured', 'order.paid'] as const)('webhook %s: one row, correct value/currency', async (ev) => {
    const { user } = await mkUser();
    const txn = await mkPendingTxn(user._id, `order_wh_${ev}`, 10);
    const res = await webhookReq(ev, `order_wh_${ev}`, 'pay_wh');
    expect(res.status).toBe(200);
    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(`purchase_${txn._id}`);
    expect(rows[0].value).toBe(10);
    expect(rows[0].currency).toBe('USD');
  });

  it('duplicate webhook delivery + later verify: still one row; late verify response carries same ids', async () => {
    const { user, token } = await mkUser();
    const txn = await mkPendingTxn(user._id, 'order_dup', 10);
    await webhookReq('payment.captured', 'order_dup', 'pay_dup');
    await webhookReq('payment.captured', 'order_dup', 'pay_dup');
    const v = await verifyReq('order_dup', 'pay_dup', token);
    expect(v.status).toBe(200);
    expect(v.body.metaEventId).toBe(`purchase_${txn._id}`);
    expect(v.body.value).toBe(10);
    expect(v.body.currency).toBe('USD');
    expect(await purchaseRows()).toHaveLength(1);
    expect((await User.findById(user._id).lean() as any).walletBalance).toBe(10);
  });

  it('concurrent verify x3 + webhook x2 (+ sync): one increment, one row BEFORE any reconciler, every verify response carries the id', async () => {
    const { user, token } = await mkUser();
    const txn = await mkPendingTxn(user._id, 'order_race', 10);
    mockFetchOrder.mockResolvedValue({ id: 'order_race', status: 'paid', amount: 1000, amount_paid: 1000, currency: 'USD' });
    const results = await Promise.all([
      verifyReq('order_race', 'pay_race', token),
      verifyReq('order_race', 'pay_race', token),
      verifyReq('order_race', 'pay_race', token),
      webhookReq('payment.captured', 'order_race', 'pay_race'),
      webhookReq('order.paid', 'order_race', 'pay_race'),
      syncReq('order_race', token),
    ]);
    expect((await User.findById(user._id).lean() as any).walletBalance).toBe(10);
    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(`purchase_${txn._id}`);
    for (const r of results.slice(0, 3)) {
      expect(r.status).toBe(200);
      expect(r.body.metaEventId).toBe(`purchase_${txn._id}`);
      expect(r.body.value).toBe(10);
      expect(r.body.currency).toBe('USD');
    }
  });

  it('sync (already-completed branch): returns ids when walletCredited=true regardless of who credited', async () => {
    const { user, token } = await mkUser();
    const credited = new Date(Date.now() - 3600_000);
    const txn: any = await Transaction.create({
      userId: user._id, type: 'credit', amount: 25, description: 'Wallet top-up', razorpayOrderId: 'order_sync_done',
      status: 'completed', metadata: { walletCredited: true, walletCreditedAt: credited },
    } as any);
    const res = await syncReq('order_sync_done', token);
    expect(res.status).toBe(200);
    expect(res.body.metaEventId).toBe(`purchase_${txn._id}`);
    expect(res.body.value).toBe(25);
    expect(res.body.currency).toBe('USD');
  });

  it('verify-payment on a txn credited elsewhere (completed + walletCredited) returns ids and does not re-credit', async () => {
    const { user, token } = await mkUser({ walletBalance: 10 });
    const txn: any = await Transaction.create({
      userId: user._id, type: 'credit', amount: 10, description: 'Wallet top-up', razorpayOrderId: 'order_other',
      status: 'completed', metadata: { walletCredited: true, walletCreditedAt: new Date() },
    } as any);
    const res = await verifyReq('order_other', 'pay_other', token);
    expect(res.status).toBe(200);
    expect(res.body.metaEventId).toBe(`purchase_${txn._id}`);
    expect(res.body.value).toBe(10);
    expect((await User.findById(user._id).lean() as any).walletBalance).toBe(10);
  });

  it('completed but walletCredited !== true: NO metaEventId in sync/verify responses and NO outbox row', async () => {
    for (const meta of [{}, { walletCredited: false }, { walletCredited: 'true' }, { walletCredited: 1 }] as any[]) {
      const { user, token } = await mkUser();
      const oid = `order_nocredit_${Math.random().toString(36).slice(2)}`;
      await Transaction.create({
        userId: user._id, type: 'credit', amount: 10, description: 'Wallet top-up', razorpayOrderId: oid,
        status: 'completed', metadata: meta,
      } as any);
      const s = await syncReq(oid, token);
      expect(s.body.metaEventId).toBeUndefined();
      expect(s.body.value).toBeUndefined();
      expect(s.body.currency).toBeUndefined();
      const v = await verifyReq(oid, 'pay_x', token);
      expect(v.body.metaEventId).toBeUndefined();
      expect(v.body.value).toBeUndefined();
      expect(v.body.currency).toBeUndefined();
      await webhookReq('payment.captured', oid, 'pay_x');
    }
    expect(await purchaseRows()).toHaveLength(0);
  });

  it('pending / failed / cancelled orders never carry ids and never enqueue', async () => {
    const { user, token } = await mkUser();
    await mkPendingTxn(user._id, 'order_pend', 10);
    await mkPendingTxn(user._id, 'order_fail', 10);
    await mkPendingTxn(user._id, 'order_cancel', 10);
    mockFetchOrder.mockResolvedValue({ id: 'order_pend', status: 'created', amount: 1000, amount_paid: 0 });
    const sPend = await syncReq('order_pend', token);
    expect(sPend.body.metaEventId).toBeUndefined();
    await webhookReq('payment.failed', 'order_fail', 'pay_f');
    const cancel = await request(app).post('/api/wallet/cancel-order').set('Authorization', `Bearer ${token}`).send({ orderId: 'order_cancel' });
    expect(cancel.body.metaEventId).toBeUndefined();
    const sFail = await syncReq('order_fail', token);
    expect(sFail.body.metaEventId).toBeUndefined();
    expect(await purchaseRows()).toHaveLength(0);
    // an invalid-signature verify must not credit or enqueue either
    const bad = await request(app).post('/api/wallet/verify-payment').set('Authorization', `Bearer ${token}`)
      .send({ orderId: 'order_pend', paymentId: 'pay_p', signature: 'deadbeef' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.body.metaEventId).toBeUndefined();
    expect(await purchaseRows()).toHaveLength(0);
    expect((await User.findById(user._id).lean() as any).walletBalance).toBe(0);
  });

  it('manual credit (no razorpayOrderId), welcome bonus, matching debit: no Purchase rows even after reconciler', async () => {
    const { user } = await mkUser();
    await Transaction.create([
      { userId: user._id, type: 'credit', amount: 3, description: 'Welcome bonus', status: 'completed', metadata: {} },
      { userId: user._id, type: 'debit', amount: 0.3, description: 'Daily matching', status: 'completed', metadata: {} },
      { userId: user._id, type: 'credit', amount: 50, description: 'Manual credit', status: 'completed',
        metadata: { walletCredited: true, walletCreditedAt: new Date() } },
    ] as any);
    const r = await creditTransactionOnce('order_does_not_exist', { source: 'test' });
    expect(r.credited).toBe(false);
    await reconcileMetaEvents();
    expect(await purchaseRows()).toHaveLength(0);
  });

  it('creditTransactionOnce: exactly one winner among 6 concurrent calls; winner reports metaEventId/value/currency', async () => {
    const { user } = await mkUser();
    const txn = await mkPendingTxn(user._id, 'order_cto', 10);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => creditTransactionOnce('order_cto', { paymentId: 'pay_cto', source: 'test' }))
    );
    const winners = results.filter((r) => r.credited);
    expect(winners).toHaveLength(1);
    expect(winners[0].metaEventId).toBe(`purchase_${txn._id}`);
    expect(winners[0].value).toBe(10);
    expect(winners[0].currency).toBe('USD');
    expect(await purchaseRows()).toHaveLength(1);
    expect((await User.findById(user._id).lean() as any).walletBalance).toBe(10);
  });

  it('credit still succeeds when the outbox insert throws (and the txn is still completed)', async () => {
    const { user, token } = await mkUser();
    await mkPendingTxn(user._id, 'order_outbox_down', 10);
    const brk = breakOutbox();
    const res = await verifyReq('order_outbox_down', 'pay_od', token);
    const calls = brk.calls();
    brk.restore();
    expect(calls).toBeGreaterThan(0);
    expect(res.status).toBe(200);
    expect((await User.findById(user._id).lean() as any).walletBalance).toBe(10);
    const t: any = await Transaction.findOne({ razorpayOrderId: 'order_outbox_down' }).lean();
    expect(t.status).toBe('completed');
    expect(t.metadata.walletCredited).toBe(true);
    expect(await purchaseRows()).toHaveLength(0);
  });

  it('after outbox failure the reconciler recovers exactly one row for the credited txn (idempotent)', async () => {
    const { user, token } = await mkUser();
    const txn = await mkPendingTxn(user._id, 'order_recover', 10);
    const brk = breakOutbox();
    await verifyReq('order_recover', 'pay_rc', token);
    brk.restore();
    expect(await purchaseRows()).toHaveLength(0);
    await reconcileMetaEvents();
    await reconcileMetaEvents();
    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(`purchase_${txn._id}`);
    expect(rows[0].value).toBe(10);
  });

  it('gating: credit with Meta disabled writes no row but still credits; response omits nothing wallet-related', async () => {
    metaOff();
    const { user, token } = await mkUser();
    await mkPendingTxn(user._id, 'order_off', 10);
    const res = await verifyReq('order_off', 'pay_off', token);
    expect(res.status).toBe(200);
    expect((await User.findById(user._id).lean() as any).walletBalance).toBe(10);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('em/external_id are hashed; no raw email in the Purchase row', async () => {
    const { user, token } = await mkUser();
    await mkPendingTxn(user._id, 'order_hash', 10);
    await verifyReq('order_hash', 'pay_h', token);
    const [row] = await purchaseRows();
    expect(row.userData.em).toBe(sha256(String(user.email).trim().toLowerCase()));
    expect(row.userData.external_id).toBe(sha256(String(user._id)));
    expect(JSON.stringify(row).toLowerCase()).not.toContain(String(user.email).toLowerCase());
  });
});

describe('S4 Purchase user_data fallback', () => {
  it('webhook-credited order with EMPTY txn metadata uses user.attribution.fbc', async () => {
    const { user } = await mkUser({ attribution: { fbc: FBC_USER, fbp: FBP } });
    await mkPendingTxn(user._id, 'order_fb1', 10, {});
    await webhookReq('payment.captured', 'order_fb1', 'pay_fb1');
    const [row] = await purchaseRows();
    expect(row.userData.fbc).toBe(FBC_USER);
  });

  it('txn metadata fbc wins over user.attribution.fbc; txn fbp/clientIp/clientUa flow into userData', async () => {
    const { user } = await mkUser({ attribution: { fbc: FBC_USER } });
    await mkPendingTxn(user._id, 'order_fb2', 10, { fbc: FBC, fbp: FBP, clientIp: '198.51.100.9', clientUa: 'TestUA/9' });
    await webhookReq('payment.captured', 'order_fb2', 'pay_fb2');
    const [row] = await purchaseRows();
    expect(row.userData.fbc).toBe(FBC);
    expect(row.userData.fbp).toBe(FBP);
    expect(row.userData.client_ip_address).toBe('198.51.100.9');
    expect(row.userData.client_user_agent).toBe('TestUA/9');
  });

  it('never invented: no fbc anywhere -> userData has no fbc key at all (not null/empty)', async () => {
    const { user } = await mkUser();
    await mkPendingTxn(user._id, 'order_fb3', 10, {});
    await webhookReq('payment.captured', 'order_fb3', 'pay_fb3');
    const [row] = await purchaseRows();
    expect(row.userData.fbc).toBeUndefined();
    expect(row.userData.fbp).toBeUndefined();
    expect(row.userData).not.toHaveProperty('fbc');
    expect(row.userData).not.toHaveProperty('fbp');
  });

  it('empty-string txn fbc falls back to user fbc rather than sending ""', async () => {
    const { user } = await mkUser({ attribution: { fbc: FBC_USER } });
    await mkPendingTxn(user._id, 'order_fb4', 10, { fbc: '' });
    await webhookReq('payment.captured', 'order_fb4', 'pay_fb4');
    const [row] = await purchaseRows();
    expect(row.userData.fbc).toBe(FBC_USER);
  });

  it('webhook path has no request context: IP/UA of the webhook caller are NOT used as the buyer IP/UA', async () => {
    const { user } = await mkUser();
    await mkPendingTxn(user._id, 'order_fb5', 10, {});
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_fb5', order_id: 'order_fb5' } }, order: { entity: { id: 'order_fb5' } } },
    });
    const crypto = await import('crypto');
    const sig = crypto.createHmac('sha256', 'test-webhook-secret-6a4p').update(body).digest('hex');
    await request(app).post('/api/wallet/webhook').set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig).set('User-Agent', 'Razorpay-Webhook/1.0').set('X-Forwarded-For', '52.1.2.3').send(body);
    const [row] = await purchaseRows();
    expect(row.userData.client_ip_address).toBeUndefined();
    expect(row.userData.client_user_agent).toBeUndefined();
  });
});

describe('create-order captures click ids + server-derived IP/UA (S2 contract, S7)', () => {
  const mkOrder = (id: string) => mockCreateOrder.mockResolvedValue({ id, amount: 1000, currency: 'USD', status: 'created' });

  it('persists valid fbc/fbp and server-derived ip/ua on Transaction metadata', async () => {
    const { user, token } = await mkUser();
    mkOrder('order_co1');
    const res = await request(app).post('/api/wallet/create-order')
      .set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '203.0.113.55').set('User-Agent', 'MyBrowser/7.1')
      .send({ amount: 10, metaClick: { fbc: FBC, fbp: FBP } });
    expect(res.status).toBe(200);
    const t: any = await Transaction.findOne({ razorpayOrderId: 'order_co1' }).lean();
    expect(t.userId.toString()).toBe(user._id.toString());
    expect(t.metadata.fbc).toBe(FBC);
    expect(t.metadata.fbp).toBe(FBP);
    expect(t.metadata.clientIp).toBe('203.0.113.55');
    expect(t.metadata.clientUa).toBe('MyBrowser/7.1');
  });

  it('a client cannot spoof clientIp/clientUa via the body', async () => {
    const { token } = await mkUser();
    mkOrder('order_co2');
    await request(app).post('/api/wallet/create-order')
      .set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '203.0.113.56').set('User-Agent', 'RealUA')
      .send({ amount: 10, clientIp: '1.1.1.1', clientUa: 'Spoof', metadata: { clientIp: '1.1.1.1', walletCredited: true },
        metaClick: { fbc: FBC, clientIp: '2.2.2.2' } });
    const t: any = await Transaction.findOne({ razorpayOrderId: 'order_co2' }).lean();
    expect(t.metadata.clientIp).toBe('203.0.113.56');
    expect(t.metadata.clientUa).toBe('RealUA');
    expect(t.metadata.walletCredited).not.toBe(true);
    expect(t.status).toBe('pending');
  });

  it('invalid fbc/fbp dropped (not stored) while the order is still created', async () => {
    const { token } = await mkUser();
    mkOrder('order_co3');
    const res = await request(app).post('/api/wallet/create-order').set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, metaClick: { fbc: 'garbage value', fbp: 'fb.2.1.x', fbclid: '<x>' } });
    expect(res.status).toBe(200);
    const t: any = await Transaction.findOne({ razorpayOrderId: 'order_co3' }).lean();
    expect(t.metadata?.fbc).toBeUndefined();
    expect(t.metadata?.fbp).toBeUndefined();
    expect(JSON.stringify(t.metadata ?? {})).not.toContain('garbage');
  });

  const malformed: Array<[string, any]> = [
    ['string', 'garbage'], ['number', 99], ['array', [FBC]], ['null', null], ['huge string', 'x'.repeat(300_000)],
    ['nested', { fbc: { a: 1 }, fbp: [[]] }], ['huge values', { fbc: 'fb.1.' + 'a'.repeat(100_000) }],
  ];
  it.each(malformed)('malformed metaClick (%s) never breaks order creation', async (_n, mc) => {
    const { token } = await mkUser();
    const id = `order_mal_${Math.random().toString(36).slice(2)}`;
    mkOrder(id);
    const res = await request(app).post('/api/wallet/create-order').set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, metaClick: mc });
    expect(res.status).toBe(200);
    const t: any = await Transaction.findOne({ razorpayOrderId: id }).lean();
    expect(t).toBeTruthy();
    expect(t.metadata?.fbc).toBeUndefined();
    expect(t.metadata?.fbp).toBeUndefined();
  });

  it('create-order end-to-end: click ids captured at order time end up on the Purchase row after a webhook credit', async () => {
    const { user, token } = await mkUser();
    mkOrder('order_e2e');
    await request(app).post('/api/wallet/create-order').set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', '203.0.113.77').set('User-Agent', 'E2E-UA')
      .send({ amount: 10, metaClick: { fbc: FBC, fbp: FBP } });
    await webhookReq('payment.captured', 'order_e2e', 'pay_e2e');
    const [row] = await purchaseRows();
    expect(String(row.userId)).toBe(String(user._id));
    expect(row.userData.fbc).toBe(FBC);
    expect(row.userData.fbp).toBe(FBP);
    expect(row.userData.client_ip_address).toBe('203.0.113.77');
    expect(row.userData.client_user_agent).toBe('E2E-UA');
  });

  it('unauthenticated create-order is rejected and creates nothing', async () => {
    const res = await request(app).post('/api/wallet/create-order').send({ amount: 10, metaClick: { fbc: FBC } });
    expect(res.status).toBe(401);
    expect(await Transaction.countDocuments({})).toBe(0);
  });
});

// keep tokenFor/DAY referenced for clarity in future edits
void tokenFor; void DAY;
