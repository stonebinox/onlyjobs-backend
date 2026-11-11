// 6a4p adversarial: S1 gating, S2 CompleteRegistration, S6 hashing/allow-list, S7 metaClick.
// Oracle = bd task requirements only. Implementation bodies were not read.
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

import {
  metaOn, metaOff, saveMetaEnv, restoreMetaEnv, signupReq, outboxRows, breakOutbox, sha256,
  User, MetaEventOutbox, GO_LIVE, DAY,
} from './6a4p.helpers';
import {
  getMetaCapiStartAt, isMetaEnqueueEnabled, hashEmail, sanitizeMetaClick, buildMetaUserData,
  enqueueMetaEvent, enqueueCompleteRegistration, enqueueActivated, enqueuePurchase, regEventId, actEventId, purchaseEventId, toUnixSeconds,
} from '../utils/metaEvents';
import { reconcileMetaEvents } from '../services/metaReconciler';
import { startMetaDrainWorker, stopMetaDrainWorker } from '../services/metaDrainWorker';
import { resolveMetaWorkerConfig } from '../services/metaCapi';

const FBC = 'fb.1.1700000000000.AbCdEf123';
const FBP = 'fb.1.1700000000000.1234567890';

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

describe('S1 gating (env flags)', () => {
  it('getMetaCapiStartAt: Date for valid ISO, null for garbage/empty/unset', () => {
    process.env.META_CAPI_START_AT = '2026-03-04T05:06:07.000Z';
    expect(getMetaCapiStartAt()?.toISOString()).toBe('2026-03-04T05:06:07.000Z');
    for (const bad of ['not-a-date', '', '   ', 'undefined']) {
      process.env.META_CAPI_START_AT = bad;
      expect(getMetaCapiStartAt()).toBeNull();
    }
    delete process.env.META_CAPI_START_AT;
    expect(getMetaCapiStartAt()).toBeNull();
  });

  it('isMetaEnqueueEnabled: true only for ENABLED="true" AND valid START_AT', () => {
    expect(isMetaEnqueueEnabled()).toBe(true);
    process.env.META_CAPI_ENABLED = 'false';
    expect(isMetaEnqueueEnabled()).toBe(false);
    delete process.env.META_CAPI_ENABLED;
    expect(isMetaEnqueueEnabled()).toBe(false);
    process.env.META_CAPI_ENABLED = 'true';
    process.env.META_CAPI_START_AT = 'garbage';
    expect(isMetaEnqueueEnabled()).toBe(false);
    delete process.env.META_CAPI_START_AT;
    expect(isMetaEnqueueEnabled()).toBe(false);
  });

  const offModes: Array<[string, () => void]> = [
    ['ENABLED unset', () => delete process.env.META_CAPI_ENABLED],
    ['ENABLED=false', () => (process.env.META_CAPI_ENABLED = 'false')],
    ['START_AT unset', () => delete process.env.META_CAPI_START_AT],
    ['START_AT invalid', () => (process.env.META_CAPI_START_AT = 'soon')],
  ];
  it.each(offModes)('signup writes ZERO outbox rows and never calls graph.facebook.com when %s', async (_n, off) => {
    off();
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation((() => {
      throw new Error('fetch must not be called when Meta is disabled');
    }) as any);
    const res = await signupReq({ email: `off-${Math.random()}@example.com`, password: 'pw12345678' });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(await outboxRows()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(offModes)('enqueueCompleteRegistration/Activated/Purchase insert nothing when %s', async (_n, off) => {
    off();
    const uid = new User()._id;
    await enqueueCompleteRegistration({ _id: uid, email: 'g@example.com', createdAt: new Date() });
    await enqueueActivated({ _id: uid, email: 'g@example.com', createdAt: new Date() }, new Date());
    await enqueuePurchase(
      { _id: new User()._id, userId: uid, amount: 10, metadata: { walletCredited: true, walletCreditedAt: new Date() } },
      { email: 'g@example.com' }
    );
    expect(await outboxRows()).toHaveLength(0);
  });

  it.each(offModes)('reconciler enqueues nothing when %s', async (_n, off) => {
    const u: any = await User.create({ email: 'rec-off@example.com', password: 'x' });
    await User.collection.updateOne({ _id: u._id }, { $set: { createdAt: new Date(Date.now() - 1000) } });
    off();
    await reconcileMetaEvents().catch(() => undefined);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('worker config resolver: ok only when every setting present and valid', () => {
    const base = {
      META_CAPI_ENABLED: 'true', META_CAPI_START_AT: GO_LIVE, META_PIXEL_ID: '123456789',
      META_CAPI_ACCESS_TOKEN: 'TOK_SECRET_VALUE', META_GRAPH_API_VERSION: 'v19.0',
    };
    const apply = (o: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries({ ...base, ...o })) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    };
    apply({});
    const ok = resolveMetaWorkerConfig();
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.pixelId).toBe('123456789');
      expect(ok.config.accessToken).toBe('TOK_SECRET_VALUE');
      expect(ok.config.graphApiVersion).toBe('v19.0');
    }
    for (const k of ['META_CAPI_START_AT', 'META_PIXEL_ID', 'META_CAPI_ACCESS_TOKEN', 'META_GRAPH_API_VERSION']) {
      apply({ [k]: undefined });
      const r = resolveMetaWorkerConfig();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(Array.isArray(r.missing)).toBe(true);
        expect(r.missing.length).toBeGreaterThan(0);
        expect(JSON.stringify(r.missing)).not.toContain('TOK_SECRET_VALUE');
      }
    }
    apply({ META_CAPI_START_AT: 'nonsense' });
    expect(resolveMetaWorkerConfig().ok).toBe(false);
  });

  it.each(['', 'garbage', '../../evil', 'v19.0/../x', 'v19.0?x=1', 'v19.0#frag', 'https://evil.test', '19.0'])(
    'worker config resolver rejects unsafe/invalid GRAPH_API_VERSION %p (URL-path injection)',
    (badVer) => {
      Object.assign(process.env, {
        META_CAPI_ENABLED: 'true', META_CAPI_START_AT: GO_LIVE, META_PIXEL_ID: '123456789',
        META_CAPI_ACCESS_TOKEN: 'tok', META_GRAPH_API_VERSION: badVer,
      });
      expect(resolveMetaWorkerConfig().ok).toBe(false);
    }
  );

  it('worker does not start (no fetch, no throw) when token missing; stop resolves', async () => {
    process.env.META_PIXEL_ID = '123456789';
    process.env.META_GRAPH_API_VERSION = 'v19.0';
    delete process.env.META_CAPI_ACCESS_TOKEN;
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('no network allowed'));
    await MetaEventOutbox.create({
      eventId: 'reg_due', eventName: 'CompleteRegistration', eventTime: Math.floor(Date.now() / 1000),
      userId: new User()._id, userData: {}, status: 'pending', attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1000), purgeAt: new Date(Date.now() + 30 * DAY),
    } as any);
    expect(() => startMetaDrainWorker()).not.toThrow();
    await new Promise((r) => setTimeout(r, 400));
    await stopMetaDrainWorker();
    expect(fetchSpy).not.toHaveBeenCalled();
    const row: any = await MetaEventOutbox.findOne({ eventId: 'reg_due' }).lean();
    expect(row.status).toBe('pending');
  });

  it('worker does not start when disabled even with full credentials', async () => {
    process.env.META_PIXEL_ID = '123456789';
    process.env.META_GRAPH_API_VERSION = 'v19.0';
    process.env.META_CAPI_ACCESS_TOKEN = 'tok';
    metaOff();
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('no network allowed'));
    await MetaEventOutbox.create({
      eventId: 'reg_due2', eventName: 'CompleteRegistration', eventTime: Math.floor(Date.now() / 1000),
      userId: new User()._id, userData: {}, status: 'pending', attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1000), purgeAt: new Date(Date.now() + 30 * DAY),
    } as any);
    startMetaDrainWorker();
    await new Promise((r) => setTimeout(r, 400));
    await stopMetaDrainWorker();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('event id helpers', () => {
  it('format reg_/act_/purchase_ and toUnixSeconds floors to seconds', () => {
    expect(regEventId('abc')).toBe('reg_abc');
    expect(actEventId('abc')).toBe('act_abc');
    expect(purchaseEventId('t1')).toBe('purchase_t1');
    expect(toUnixSeconds(new Date(1_700_000_000_999))).toBe(1_700_000_000);
    expect(toUnixSeconds(new Date(1_700_000_000_000))).toBe(1_700_000_000);
    expect(String(toUnixSeconds(new Date())).length).toBe(10);
  });
});

describe('S2 CompleteRegistration', () => {
  it('new account: exactly one reg_<userId> row, response carries same metaEventId', async () => {
    const res = await signupReq({ email: 'fresh@example.com', password: 'pw12345678' });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.metaEventId).toBe(`reg_${res.body.id}`);
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(`reg_${res.body.id}`);
    expect(rows[0].eventName).toBe('CompleteRegistration');
    expect(String(rows[0].userId)).toBe(String(res.body.id));
    expect(String(rows[0].eventTime)).toMatch(/^\d{10}$/);
    expect(Math.abs(rows[0].eventTime - Math.floor(Date.now() / 1000))).toBeLessThan(120);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBe(0);
  });

  it('login of existing account: zero rows, no metaEventId', async () => {
    await User.create({ email: 'exists@example.com', password: 'hashed_pw12345678' });
    const res = await signupReq({ email: 'exists@example.com', password: 'pw12345678' });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    expect(res.body.metaEventId).toBeUndefined();
    expect(await outboxRows()).toHaveLength(0);
  });

  it('repeated logins never create rows', async () => {
    const first = await signupReq({ email: 'twice@example.com', password: 'pw12345678' });
    expect(first.body.isNewUser).toBe(true);
    for (let i = 0; i < 3; i++) {
      const r = await signupReq({ email: 'twice@example.com', password: 'pw12345678' });
      expect(r.body.isNewUser).toBe(false);
      expect(r.body.metaEventId).toBeUndefined();
    }
    expect(await outboxRows()).toHaveLength(1);
  });

  it('wrong password: 401, zero rows, no metaEventId', async () => {
    await User.create({ email: 'wrong@example.com', password: 'hashed_right' });
    const res = await signupReq({ email: 'wrong@example.com', password: 'wrongpass99' });
    expect(res.status).toBe(401);
    expect(res.body.metaEventId).toBeUndefined();
    expect(await outboxRows()).toHaveLength(0);
  });

  it('concurrent duplicate signup for the same email: exactly one user and one reg_ row', async () => {
    const email = 'race@example.com';
    const results = await Promise.all(
      Array.from({ length: 6 }, () => signupReq({ email, password: 'pw12345678' }))
    );
    expect(await User.countDocuments({ email })).toBe(1);
    const user: any = await User.findOne({ email }).lean();
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(`reg_${user._id}`);
    // At most one response may claim to be the new-user signup carrying the event id.
    const withEvent = results.filter((r) => r.body && r.body.metaEventId);
    expect(withEvent.length).toBeLessThanOrEqual(1);
    for (const r of withEvent) expect(r.body.metaEventId).toBe(`reg_${user._id}`);
  });

  it('signup still succeeds (200, user created) when the outbox insert throws', async () => {
    const brk = breakOutbox();
    const res = await signupReq({ email: 'outbox-down@example.com', password: 'pw12345678' });
    const calls = brk.calls();
    brk.restore();
    expect(calls).toBeGreaterThan(0); // the failure path was really exercised
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(await User.countDocuments({ email: 'outbox-down@example.com' })).toBe(1);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('row never holds the raw email; userData only has hashed identifiers', async () => {
    const email = 'Raw.Person@Rawdomain.test';
    await signupReq({ email, password: 'pw12345678' });
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    const blob = JSON.stringify(rows[0]).toLowerCase();
    expect(blob).not.toContain('raw.person');
    expect(blob).not.toContain('rawdomain');
    expect(rows[0].userData.em).toBe(sha256(email.trim().toLowerCase()));
    expect(rows[0].userData.external_id).toBe(sha256(String(rows[0].userId)));
  });

  it('purgeAt is ~30 days ahead on insert (S11)', async () => {
    await signupReq({ email: 'purge@example.com', password: 'pw12345678' });
    const [row] = await outboxRows();
    const delta = new Date(row.purgeAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(29 * DAY);
    expect(delta).toBeLessThan(31 * DAY);
  });

  it('valid fbc/fbp from metaClick reach the reg_ row userData and User.attribution', async () => {
    const res = await signupReq({
      email: 'click@example.com', password: 'pw12345678',
      metaClick: { fbclid: 'AbC123_-.x', fbc: FBC, fbp: FBP },
    });
    expect(res.status).toBe(200);
    const u: any = await User.findOne({ email: 'click@example.com' }).lean();
    expect(u.attribution?.fbc).toBe(FBC);
    expect(u.attribution?.fbp).toBe(FBP);
    expect(u.attribution?.fbclid).toBe('AbC123_-.x');
    const [row] = await outboxRows();
    expect(row.userData.fbc).toBe(FBC);
    expect(row.userData.fbp).toBe(FBP);
  });
});

describe('S6 hashing and allow-list', () => {
  it('em = sha256 of trimmed lowercased email (fixed oracle)', () => {
    expect(hashEmail('  Test.User@Example.COM ')).toBe(
      'a97d7a4513204a9cc7cb2f11d72d41a59b18d1ba633d22e58d53c625518f5203'
    );
    expect(sha256('test.user@example.com')).toBe(
      'a97d7a4513204a9cc7cb2f11d72d41a59b18d1ba633d22e58d53c625518f5203'
    );
    expect(hashEmail('test.user@example.com')).toBe(hashEmail('TEST.USER@EXAMPLE.COM'));
  });

  it('empty / whitespace email yields no em (never invented)', () => {
    expect(hashEmail('')).toBeUndefined();
    expect(hashEmail('   ')).toBeUndefined();
    const ud = buildMetaUserData({ userId: 'u1', email: '  ' });
    expect(ud.em).toBeUndefined();
    expect(buildMetaUserData({ userId: 'u1', email: null }).em).toBeUndefined();
  });

  it('buildMetaUserData: hashed email + external_id, passes ip/ua/fbc/fbp through, only six keys', () => {
    const ud: any = buildMetaUserData({
      userId: 'user-123', email: '  Test.User@Example.COM ', ip: '203.0.113.7', ua: 'UA/1.0', fbc: FBC, fbp: FBP,
      // extra keys that must not leak
      phone: '+15551234567', password: 'secret', name: 'Jane Doe', raw_email: 'Test.User@Example.COM',
    } as any);
    expect(ud.em).toBe('a97d7a4513204a9cc7cb2f11d72d41a59b18d1ba633d22e58d53c625518f5203');
    expect(ud.external_id).toBe(sha256('user-123'));
    expect(ud.client_ip_address).toBe('203.0.113.7');
    expect(ud.client_user_agent).toBe('UA/1.0');
    expect(ud.fbc).toBe(FBC);
    expect(ud.fbp).toBe(FBP);
    const allowed = ['em', 'external_id', 'client_ip_address', 'client_user_agent', 'fbc', 'fbp'];
    for (const k of Object.keys(ud)) expect(allowed).toContain(k);
    const blob = JSON.stringify(ud);
    expect(blob).not.toContain('Test.User@Example.COM');
    expect(blob.toLowerCase()).not.toContain('test.user@example.com');
    expect(blob).not.toContain('Jane');
    expect(blob).not.toContain('5551234567');
  });

  it('external_id uses the string form of an ObjectId', () => {
    const id = new User()._id;
    expect(buildMetaUserData({ userId: id }).external_id).toBe(sha256(String(id)));
  });

  it('stored outbox row drops unknown userData keys and never stores raw email', async () => {
    const uid = new User()._id;
    const ok = await enqueueMetaEvent({
      eventId: `reg_${uid}`, eventName: 'CompleteRegistration', eventTime: Math.floor(Date.now() / 1000),
      userId: uid,
      userData: { em: sha256('a@b.co'), email: 'leak@leak.com', phone: '123', password: 'pw' } as any,
    });
    expect(ok).toBe(true);
    const [row] = await outboxRows();
    const blob = JSON.stringify(row);
    expect(blob).not.toContain('leak@leak.com');
    expect(blob).not.toContain('"phone"');
    expect(blob).not.toContain('"password"');
    for (const k of Object.keys(row.userData ?? {})) {
      expect(['em', 'external_id', 'client_ip_address', 'client_user_agent', 'fbc', 'fbp']).toContain(k);
    }
  });

  it('enqueueMetaEvent is idempotent on eventId (second insert returns false, one row)', async () => {
    const uid = new User()._id;
    const input = {
      eventId: `reg_${uid}`, eventName: 'CompleteRegistration' as const,
      eventTime: Math.floor(Date.now() / 1000), userId: uid, userData: {},
    };
    const results = await Promise.all([enqueueMetaEvent(input), enqueueMetaEvent(input), enqueueMetaEvent(input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
  });
});

describe('S7 metaClick sanitisation', () => {
  const empty = (v: unknown) => v === undefined || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);

  it('keeps valid values verbatim', () => {
    expect(sanitizeMetaClick({ fbclid: 'AbC123_-.x', fbc: FBC, fbp: FBP })).toEqual({
      fbclid: 'AbC123_-.x', fbc: FBC, fbp: FBP,
    });
  });

  it('non-objects yield nothing', () => {
    for (const v of [undefined, null, 'str', 42, true, [], [{ fbc: FBC }], () => 1]) {
      expect(empty(sanitizeMetaClick(v as any))).toBe(true);
    }
  });

  it('drops values with characters outside [A-Za-z0-9._-]', () => {
    for (const bad of ['a b', 'a/b', 'a;b', '<script>', "a'b", 'a\nb', 'é', 'a%20b', 'a=b', 'a,b', 'a+b']) {
      const r: any = sanitizeMetaClick({ fbclid: bad });
      expect(r?.fbclid).toBeUndefined();
    }
    for (const bad of ['fb.1.abc def', 'fb.1.a/b', 'fb.1.<x>']) {
      expect((sanitizeMetaClick({ fbc: bad, fbp: bad }) as any)?.fbc).toBeUndefined();
      expect((sanitizeMetaClick({ fbc: bad, fbp: bad }) as any)?.fbp).toBeUndefined();
    }
  });

  it('fbc/fbp must start with "fb.1."', () => {
    for (const bad of ['fb.2.1700000000000.abc', 'xfb.1.abc', 'FB.1.abc', 'fb1.1.abc', 'abc', 'fb.1', 'fb.']) {
      expect((sanitizeMetaClick({ fbc: bad }) as any)?.fbc).toBeUndefined();
      expect((sanitizeMetaClick({ fbp: bad }) as any)?.fbp).toBeUndefined();
    }
    // fbclid has no prefix requirement
    expect((sanitizeMetaClick({ fbclid: 'anything.ok' }) as any)?.fbclid).toBe('anything.ok');
  });

  it('length boundary: fbclid 512 kept/513 dropped; fbc and fbp 600 kept/601 dropped', () => {
    const id512 = 'a'.repeat(512);
    const id513 = 'a'.repeat(513);
    const fb600 = 'fb.1.' + 'a'.repeat(595);
    const fb601 = 'fb.1.' + 'a'.repeat(596);
    expect(fb600).toHaveLength(600);
    expect(fb601).toHaveLength(601);

    const ok: any = sanitizeMetaClick({ fbclid: id512, fbc: fb600, fbp: fb600 });
    expect(ok.fbclid).toBe(id512);
    expect(ok.fbc).toBe(fb600);
    expect(ok.fbp).toBe(fb600);

    const bad: any = sanitizeMetaClick({ fbclid: id513, fbc: fb601, fbp: fb601 });
    expect(bad?.fbclid).toBeUndefined();
    expect(bad?.fbc).toBeUndefined();
    expect(bad?.fbp).toBeUndefined();

    // Each field is bounded independently: an over-long sibling must not drop a valid one.
    const mixed: any = sanitizeMetaClick({ fbclid: id513, fbc: fb600, fbp: fb601 });
    expect(mixed.fbclid).toBeUndefined();
    expect(mixed.fbc).toBe(fb600);
    expect(mixed.fbp).toBeUndefined();
  });

  it('non-string field values are dropped, valid siblings kept, unknown keys never survive', () => {
    const r: any = sanitizeMetaClick({
      fbclid: 12345, fbc: { $gt: '' }, fbp: FBP, extra: 'x', __proto__: { polluted: 1 }, constructor: 'c',
    } as any);
    expect(r.fbclid).toBeUndefined();
    expect(r.fbc).toBeUndefined();
    expect(r.fbp).toBe(FBP);
    expect(Object.keys(r).sort()).toEqual(['fbp']);
    expect(({} as any).polluted).toBeUndefined();
    const arr: any = sanitizeMetaClick({ fbclid: ['a'], fbc: [FBC] } as any);
    expect(empty(arr)).toBe(true);
  });

  const malformed: Array<[string, any]> = [
    ['string', 'garbage'],
    ['number', 12345],
    ['array', [FBC, FBP]],
    ['array of objects', [{ fbc: FBC }]],
    ['null', null],
    ['nested objects', { fbc: { a: { b: 1 } }, fbp: [[]] }],
    ['huge string', 'x'.repeat(200_000)],
    ['huge values', { fbclid: 'a'.repeat(100_000), fbc: 'fb.1.' + 'a'.repeat(100_000) }],
    ['injection chars', { fbclid: '"}; db.dropDatabase();//', fbc: 'fb.1.$ne', fbp: '$where' }],
  ];
  it.each(malformed)('signup with malformed metaClick (%s) still succeeds and stores nothing invalid', async (_n, mc) => {
    const email = `mal-${Math.random()}@example.com`;
    const res = await signupReq({ email, password: 'pw12345678', metaClick: mc });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    const u: any = await User.findOne({ email }).lean();
    expect(u).toBeTruthy();
    expect(u.attribution?.fbclid).toBeUndefined();
    expect(u.attribution?.fbc).toBeUndefined();
    expect(u.attribution?.fbp).toBeUndefined();
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userData.fbc).toBeUndefined();
    expect(rows[0].userData.fbp).toBeUndefined();
  });

  it('partially valid metaClick: valid fbc stored, invalid fbp dropped', async () => {
    const email = 'partial@example.com';
    await signupReq({ email, password: 'pw12345678', metaClick: { fbc: FBC, fbp: 'not-a-fbp', fbclid: 'has space' } });
    const u: any = await User.findOne({ email }).lean();
    expect(u.attribution?.fbc).toBe(FBC);
    expect(u.attribution?.fbp).toBeUndefined();
    expect(u.attribution?.fbclid).toBeUndefined();
  });
});
