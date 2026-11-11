// 6a4p adversarial: S8 Graph payload, S9 drain classification, S10 reconciler, S11 retention.
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
jest.mock('bcrypt', () => ({
  hash: (pw: string) => Promise.resolve(`hashed_${pw}`),
  compare: (pw: string, h: string) => Promise.resolve(h === `hashed_${pw}`),
}));

import {
  metaOn, saveMetaEnv, restoreMetaEnv, outboxRows, signupReq, sha256, setUserCreatedAt, mkUser,
  User, Transaction, MetaEventOutbox, DAY,
} from './6a4p.helpers';
import { buildGraphEvent, drainMetaEventOutbox, getInFlightDrain, MetaWorkerConfig, resolveMetaWorkerConfig } from '../services/metaCapi';
import { reconcileMetaEvents } from '../services/metaReconciler';

const TOKEN = 'EAAB_SUPER_SECRET_TOKEN_9f8e7d';
const CFG: MetaWorkerConfig = { pixelId: '123456789012345', accessToken: TOKEN, graphApiVersion: 'v19.0' };
const RAW_EMAIL = 'raw.person@leakcheck.test';
const IP = '203.0.113.7';
const UA = 'Mozilla/5.0 (LeakCheck)';
const FBC = 'fb.1.1700000000000.AbCdEf123';
const FBP = 'fb.1.1700000000000.1234567890';

let evSeq = 0;
async function seedRow(over: Record<string, any> = {}) {
  evSeq += 1;
  const uid = new User()._id;
  const doc = {
    eventId: `reg_seed_${evSeq}_${Math.random().toString(36).slice(2, 8)}`,
    eventName: 'CompleteRegistration',
    eventTime: Math.floor(Date.now() / 1000) - 60,
    userId: uid,
    eventSourceUrl: 'https://onlyjobs.example.com/',
    userData: { em: sha256('a@b.co'), external_id: sha256(String(uid)), client_ip_address: IP, client_user_agent: UA, fbc: FBC, fbp: FBP },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 5000),
    purgeAt: new Date(Date.now() + 30 * DAY),
    ...over,
  };
  await MetaEventOutbox.create(doc as any);
  return doc.eventId as string;
}
const getRow = (eventId: string) => MetaEventOutbox.findOne({ eventId }).lean() as unknown as Promise<any>;

const json = (status: number, body: any) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: jest.Mock;
function parseCall(call: any[]) {
  const [url, init] = call;
  const raw = init?.body;
  let parsed: any;
  const text = raw instanceof URLSearchParams ? raw.toString() : typeof raw === 'string' ? raw : undefined;
  if (text !== undefined) {
    try {
      parsed = JSON.parse(text);
    } catch {
      const p = new URLSearchParams(text);
      parsed = Object.fromEntries(p.entries());
      if (typeof parsed.data === 'string') parsed.data = JSON.parse(parsed.data);
    }
  } else if (raw && typeof (raw as any).entries === 'function') {
    parsed = Object.fromEntries((raw as any).entries());
    if (typeof parsed.data === 'string') parsed.data = JSON.parse(parsed.data);
  }
  return { url: String(url), init, parsed, text: text ?? JSON.stringify(parsed ?? {}) };
}

let logs: string[] = [];
let unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeAll(async () => {
  await MetaEventOutbox.syncIndexes();
});
beforeEach(() => {
  saveMetaEnv();
  metaOn();
  fetchMock = jest.fn();
  (global as any).fetch = fetchMock;
  logs = [];
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: any[]) => {
      logs.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? `${x.message}\n${x.stack}` : JSON.stringify(x))).join(' '));
    });
  }
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  restoreMetaEnv();
  jest.restoreAllMocks();
});

describe('S8 Graph payload', () => {
  const baseRow = () => ({
    eventId: 'purchase_abc', eventName: 'Purchase', eventTime: 1_800_000_123, value: 10, currency: 'USD',
    eventSourceUrl: 'https://onlyjobs.example.com/wallet',
    userData: { em: sha256('x@y.co'), external_id: sha256('u1'), client_ip_address: IP, client_user_agent: UA, fbc: FBC, fbp: FBP },
  });

  it('Purchase: Meta field names, 10-digit seconds, website source, custom_data {value,currency}', () => {
    const ev: any = buildGraphEvent(baseRow() as any);
    expect(ev.event_name).toBe('Purchase');
    expect(ev.event_id).toBe('purchase_abc');
    expect(ev.event_time).toBe(1_800_000_123);
    expect(String(ev.event_time)).toMatch(/^\d{10}$/);
    expect(ev.action_source).toBe('website');
    expect(ev.event_source_url).toBe('https://onlyjobs.example.com/wallet');
    expect(ev.custom_data).toEqual({ value: 10, currency: 'USD' });
    expect(typeof ev.custom_data.value).toBe('number');
    const ud = ev.user_data;
    const em = Array.isArray(ud.em) ? ud.em[0] : ud.em;
    expect(em).toBe(sha256('x@y.co'));
    const xid = Array.isArray(ud.external_id) ? ud.external_id[0] : ud.external_id;
    expect(xid).toBe(sha256('u1'));
    expect(ud.client_ip_address).toBe(IP);
    expect(ud.client_user_agent).toBe(UA);
    expect(ud.fbc).toBe(FBC);
    expect(ud.fbp).toBe(FBP);
    const allowed = ['em', 'external_id', 'client_ip_address', 'client_user_agent', 'fbc', 'fbp'];
    for (const k of Object.keys(ud)) expect(allowed).toContain(k);
  });

  it.each(['CompleteRegistration', 'Activated'])('%s has NO custom_data with value/currency', (name) => {
    const row: any = { ...baseRow(), eventName: name, eventId: `x_${name}` };
    delete row.value; delete row.currency;
    const ev: any = buildGraphEvent(row);
    expect(ev.event_name).toBe(name);
    expect(ev.custom_data?.value).toBeUndefined();
    expect(ev.custom_data?.currency).toBeUndefined();
  });

  it('omits absent user_data fields (no null/undefined/empty strings) and never invents fbc', () => {
    const row: any = { ...baseRow(), userData: { external_id: sha256('u1') } };
    const ev: any = buildGraphEvent(row);
    expect(Object.keys(ev.user_data)).toEqual(['external_id']);
    expect(JSON.stringify(ev)).not.toMatch(/null|""/);
  });

  it('does not pass through unexpected user_data keys or raw PII', () => {
    const row: any = { ...baseRow(), userData: { ...baseRow().userData, email: RAW_EMAIL, phone: '555', name: 'Jane' } };
    const s = JSON.stringify(buildGraphEvent(row));
    expect(s).not.toContain(RAW_EMAIL);
    expect(s).not.toContain('"phone"');
    expect(s).not.toContain('Jane');
  });

  it('drain POSTs exactly one event per request to graph.facebook.com/<ver>/<pixel>/events; token never in URL', async () => {
    const ids = await Promise.all([seedRow(), seedRow(), seedRow()]);
    fetchMock.mockImplementation(async () => json(200, { events_received: 1, fbtrace_id: 'x' }));
    const summary = await drainMetaEventOutbox(CFG);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const seen = new Set<string>();
    for (const call of fetchMock.mock.calls) {
      const { url, init, parsed } = parseCall(call);
      expect(url.startsWith('https://graph.facebook.com/v19.0/123456789012345/events')).toBe(true);
      expect(url).not.toContain(TOKEN);
      expect(url).not.toMatch(/access_token/i);
      expect(String(init?.method).toUpperCase()).toBe('POST');
      expect(Array.isArray(parsed.data)).toBe(true);
      expect(parsed.data).toHaveLength(1);
      seen.add(parsed.data[0].event_id);
      expect(parsed.data[0].action_source).toBe('website');
      expect(String(parsed.data[0].event_time)).toMatch(/^\d{10}$/);
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(summary.sent).toBe(3);
  });

  it('test_event_code appears only when configured', async () => {
    await seedRow();
    fetchMock.mockResolvedValue(json(200, { events_received: 1 }));
    await drainMetaEventOutbox(CFG);
    const a = parseCall(fetchMock.mock.calls[0]);
    expect(a.url + a.text).not.toContain('test_event_code');
    fetchMock.mockClear();
    await seedRow();
    fetchMock.mockResolvedValue(json(200, { events_received: 1 }));
    await drainMetaEventOutbox({ ...CFG, testEventCode: 'TEST48291' });
    const b = parseCall(fetchMock.mock.calls[0]);
    expect(b.url + b.text).toContain('test_event_code');
    expect(b.url + b.text).toContain('TEST48291');
  });

  it('resolveMetaWorkerConfig carries META_TEST_EVENT_CODE only when set', () => {
    Object.assign(process.env, { META_PIXEL_ID: '1', META_CAPI_ACCESS_TOKEN: 't', META_GRAPH_API_VERSION: 'v19.0' });
    delete process.env.META_TEST_EVENT_CODE;
    let r: any = resolveMetaWorkerConfig();
    expect(r.ok).toBe(true);
    expect(r.config.testEventCode).toBeUndefined();
    process.env.META_TEST_EVENT_CODE = 'TEST555';
    r = resolveMetaWorkerConfig();
    expect(r.config.testEventCode).toBe('TEST555');
  });
});

describe('S9 drain classification', () => {
  it('2xx events_received>=1 -> sent, sentAt set, IP/UA scrubbed (S11), other userData kept', async () => {
    const id = await seedRow();
    fetchMock.mockResolvedValue(json(200, { events_received: 1, messages: [], fbtrace_id: 'abc' }));
    const s = await drainMetaEventOutbox(CFG);
    const row = await getRow(id);
    expect(row.status).toBe('sent');
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.userData.client_ip_address).toBeUndefined();
    expect(row.userData.client_user_agent).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(IP);
    expect(JSON.stringify(row)).not.toContain('LeakCheck');
    expect(s.sent).toBe(1);
    expect(s.dead).toBe(0);
    expect(s.sentWithoutFbc).toBe(0);
  });

  it('sentWithoutFbc counts sent rows lacking fbc', async () => {
    const id = await seedRow({ userData: { external_id: sha256('u'), client_ip_address: IP } });
    fetchMock.mockResolvedValue(json(200, { events_received: 1 }));
    const s = await drainMetaEventOutbox(CFG);
    expect((await getRow(id)).status).toBe('sent');
    expect(s.sentWithoutFbc).toBe(1);
  });

  it('sent rows are not re-sent by a later drain', async () => {
    await seedRow();
    fetchMock.mockResolvedValue(json(200, { events_received: 1 }));
    await drainMetaEventOutbox(CFG);
    await drainMetaEventOutbox(CFG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('2xx with events_received 0 -> NOT sent; retryable; attempts incremented; nextAttemptAt in future', async () => {
    const id = await seedRow();
    fetchMock.mockResolvedValue(json(200, { events_received: 0 }));
    const s = await drainMetaEventOutbox(CFG);
    const row = await getRow(id);
    expect(row.status).not.toBe('sent');
    expect(row.status).not.toBe('dead');
    expect(row.sentAt).toBeFalsy();
    expect(row.attempts).toBe(1);
    expect(new Date(row.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(s.sent).toBe(0);
    expect(row.userData.client_ip_address).toBe(IP); // still needed for the retry
  });

  it('2xx with unparseable/empty body is not counted as sent', async () => {
    const id = await seedRow();
    fetchMock.mockResolvedValue(new Response('<html>ok</html>', { status: 200 }));
    await drainMetaEventOutbox(CFG);
    expect((await getRow(id)).status).not.toBe('sent');
  });

  it('network error -> retry (attempts+1, future nextAttemptAt, not dead)', async () => {
    const id = await seedRow();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const s = await drainMetaEventOutbox(CFG);
    const row = await getRow(id);
    expect(['pending', 'failed']).toContain(row.status);
    expect(row.attempts).toBe(1);
    expect(new Date(row.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(s.retried).toBe(1);
    expect(s.dead).toBe(0);
  });

  it.each([408, 429, 500, 502, 503, 504])('HTTP %i -> retry, not dead', async (status) => {
    const id = await seedRow();
    fetchMock.mockResolvedValue(json(status, { error: { message: 'transient', code: 2 } }));
    const s = await drainMetaEventOutbox(CFG);
    const row = await getRow(id);
    expect(['pending', 'failed']).toContain(row.status);
    expect(row.attempts).toBe(1);
    expect(new Date(row.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(s.retried).toBe(1);
    expect(s.dead).toBe(0);
  });

  it.each([400, 422])('HTTP %i non-token error -> dead, IP/UA scrubbed', async (status) => {
    const id = await seedRow();
    fetchMock.mockResolvedValue(json(status, { error: { message: 'Invalid parameter', code: 100, type: 'OAuthException' } }));
    const s = await drainMetaEventOutbox(CFG);
    const row = await getRow(id);
    expect(row.status).toBe('dead');
    expect(row.userData.client_ip_address).toBeUndefined();
    expect(row.userData.client_user_agent).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(IP);
    expect(s.dead).toBe(1);
    expect(s.sent).toBe(0);
  });

  it.each([
    [401, { error: { message: 'Invalid OAuth access token.', code: 190, type: 'OAuthException' } }],
    [403, { error: { message: 'forbidden', code: 200 } }],
    [400, { error: { message: 'Error validating access token', code: 190 } }],
    [401, null],
    [403, null],
  ] as Array<[number, any]>)('auth failure (HTTP %i, %j): rows stay retryable (not dead) and the batch stops', async (status, body) => {
    const ids = await Promise.all([seedRow(), seedRow(), seedRow()]);
    fetchMock.mockImplementation(async () => (body ? json(status, body) : new Response('', { status })));
    const s = await drainMetaEventOutbox(CFG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(s.dead).toBe(0);
    for (const id of ids) {
      const row = await getRow(id);
      expect(row.status).not.toBe('dead');
      expect(row.status).not.toBe('sent');
    }
  });

  it('after an auth failure rows are claimable again once credentials work', async () => {
    const id = await seedRow();
    fetchMock.mockResolvedValueOnce(json(401, { error: { message: 'bad token', code: 190 } }));
    await drainMetaEventOutbox(CFG);
    // make it due again regardless of backoff policy
    await MetaEventOutbox.updateOne({ eventId: id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000), leaseUntil: null, status: 'pending' } });
    fetchMock.mockResolvedValue(json(200, { events_received: 1 }));
    await drainMetaEventOutbox(CFG);
    expect((await getRow(id)).status).toBe('sent');
  });

  it('max attempts (20): the 20th failure -> dead; the 19th -> still retryable', async () => {
    const almost = await seedRow({ attempts: 18 });
    const last = await seedRow({ attempts: 19 });
    fetchMock.mockResolvedValue(json(500, { error: { message: 'boom', code: 2 } }));
    await drainMetaEventOutbox(CFG);
    const a = await getRow(almost);
    expect(a.attempts).toBe(19);
    expect(['pending', 'failed']).toContain(a.status);
    const l = await getRow(last);
    expect(l.status).toBe('dead');
    expect(l.userData.client_ip_address).toBeUndefined();
  });

  it('retry not due yet (nextAttemptAt in the future) is not sent', async () => {
    const id = await seedRow({ nextAttemptAt: new Date(Date.now() + 3600_000) });
    await drainMetaEventOutbox(CFG);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getRow(id)).attempts).toBe(0);
  });

  it("'sending' row with an EXPIRED lease is reclaimed and sent", async () => {
    const id = await seedRow({ status: 'sending', leaseUntil: new Date(Date.now() - 60_000) });
    fetchMock.mockResolvedValue(json(200, { events_received: 1 }));
    await drainMetaEventOutbox(CFG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getRow(id)).status).toBe('sent');
  });

  it("'sending' row with a LIVE lease is NOT touched", async () => {
    const id = await seedRow({ status: 'sending', leaseUntil: new Date(Date.now() + 10 * 60_000) });
    await drainMetaEventOutbox(CFG);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getRow(id)).status).toBe('sending');
  });

  it('dead rows are never retried', async () => {
    await seedRow({ status: 'dead' });
    await drainMetaEventOutbox(CFG);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('concurrent drains (single-flight) never POST the same event twice', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => seedRow()));
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return json(200, { events_received: 1 });
    });
    const p = [drainMetaEventOutbox(CFG), drainMetaEventOutbox(CFG), drainMetaEventOutbox(CFG)];
    expect(getInFlightDrain()).not.toBeNull();
    await Promise.all(p);
    const sent = fetchMock.mock.calls.map((c) => parseCall(c).parsed.data[0].event_id);
    expect(sent.sort()).toEqual([...ids].sort());
    expect(new Set(sent).size).toBe(sent.length);
    for (const id of ids) expect((await getRow(id)).status).toBe('sent');
    expect(getInFlightDrain()).toBeNull();
  });

  it('overlapping drains started at different times still send each row once', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => seedRow()));
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return json(200, { events_received: 1 });
    });
    const a = drainMetaEventOutbox(CFG);
    await new Promise((r) => setTimeout(r, 20));
    const b = drainMetaEventOutbox(CFG);
    await Promise.all([a, b]);
    const sent = fetchMock.mock.calls.map((c) => parseCall(c).parsed.data[0].event_id);
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent.sort()).toEqual([...ids].sort());
  });

  it('shouldStop() before work: nothing is sent', async () => {
    await seedRow();
    await drainMetaEventOutbox(CFG, () => true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a drain whose fetch throws synchronously / rejects with a non-Error never causes an unhandled rejection', async () => {
    await seedRow(); await seedRow(); await seedRow();
    let n = 0;
    fetchMock.mockImplementation(() => {
      n += 1;
      if (n === 1) throw new TypeError('sync boom');
      if (n === 2) return Promise.reject('string rejection');
      return Promise.reject(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }));
    });
    await drainMetaEventOutbox(CFG).catch(() => undefined);
    const f = getInFlightDrain();
    if (f) await f.catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toHaveLength(0);
  });

  it('drain itself rejecting (DB torn down mid-flight) leaves no unhandled rejection', async () => {
    await seedRow();
    fetchMock.mockImplementation(async () => {
      throw new Error('late failure');
    });
    const p = drainMetaEventOutbox(CFG);
    p.catch(() => undefined);
    await p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toHaveLength(0);
  });

  it('logs never contain the access token, the raw email, or request body data', async () => {
    const email = RAW_EMAIL;
    await metaOn();
    await signupReq({ email, password: 'pw12345678', metaClick: { fbc: FBC, fbp: FBP } });
    await seedRow();
    const leaky = (b: string) => `Error validating access token ${TOKEN} for ${email} body=${b}`;
    const scenarios: Array<() => any> = [
      () => json(401, { error: { message: leaky('x'), code: 190 } }),
      () => json(400, { error: { message: leaky('x'), code: 100 } }),
      () => json(500, { error: { message: leaky('x') } }),
      () => { throw new Error(`connect ECONNRESET https://graph.facebook.com/v19.0/${CFG.pixelId}/events?access_token=${TOKEN}`); },
    ];
    for (const sc of scenarios) {
      await MetaEventOutbox.updateMany({}, { $set: { status: 'pending', leaseUntil: null, attempts: 0, nextAttemptAt: new Date(Date.now() - 1000) } });
      fetchMock.mockImplementation(async () => sc());
      await drainMetaEventOutbox(CFG).catch(() => undefined);
    }
    fetchMock.mockImplementation(async () => json(200, { events_received: 1 }));
    await MetaEventOutbox.updateMany({}, { $set: { status: 'pending', leaseUntil: null, nextAttemptAt: new Date(Date.now() - 1000) } });
    await drainMetaEventOutbox(CFG);
    const all = logs.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all.toLowerCase()).not.toContain(email.toLowerCase());
    expect(all).not.toContain(sha256(email));
    expect(all).not.toContain(IP);
    expect(all).not.toContain('LeakCheck');
    expect(all).not.toContain('"event_name"');
    expect(all).not.toContain('"user_data"');
    expect(all).not.toContain(FBC);
  });

  it('persisted error info never contains the token', async () => {
    const id = await seedRow();
    fetchMock.mockResolvedValue(json(500, { error: { message: `leak ${TOKEN}`, code: 2 } }));
    await drainMetaEventOutbox(CFG);
    expect(JSON.stringify(await getRow(id))).not.toContain(TOKEN);
  });
});

describe('S11 retention', () => {
  it('purgeAt required: row without purgeAt cannot be inserted', async () => {
    await expect(
      MetaEventOutbox.create({
        eventId: 'noPurge', eventName: 'Activated', eventTime: 1_800_000_000, userId: new User()._id, userData: {},
      } as any)
    ).rejects.toBeTruthy();
  });

  it('eventId unique: duplicate insert is rejected at the DB level', async () => {
    const id = await seedRow();
    await expect(seedRow({ eventId: id })).rejects.toBeTruthy();
    expect(await outboxRows({ eventId: id })).toHaveLength(1);
  });
});

describe('S10 reconciler', () => {
  const now = () => Date.now();
  async function seedFixtures() {
    const startAt = new Date(now() - 3 * DAY);
    metaOn(startAt.toISOString());
    // all "other" users are created BEFORE the window so only the intended user is a registration
    const old = await mkUser();
    await setUserCreatedAt(old.user._id, new Date(now() - 6 * DAY));
    const uid = old.user._id;
    const t = (o: Record<string, any>) => Transaction.create({ userId: uid, status: 'completed', description: 'x', ...o } as any) as any;
    const welcome = await t({ type: 'credit', amount: 3, description: 'Welcome bonus', metadata: {} });
    const debit = await t({ type: 'debit', amount: 0.3, description: 'Daily matching', metadata: {} });
    const manual = await t({ type: 'credit', amount: 50, description: 'Manual', metadata: { walletCredited: true, walletCreditedAt: new Date(now() - DAY) } });
    const preTop = await t({ type: 'credit', amount: 10, razorpayOrderId: 'order_pre', metadata: { walletCredited: true, walletCreditedAt: new Date(now() - 5 * DAY) } });
    const credAt = new Date(now() - DAY);
    const postTop = await t({ type: 'credit', amount: 10, razorpayOrderId: 'order_post', metadata: { walletCredited: true, walletCreditedAt: credAt } });
    const noMarker = await t({ type: 'credit', amount: 10, razorpayOrderId: 'order_nomarker', metadata: {} });
    const pend = await Transaction.create({ userId: uid, type: 'credit', amount: 10, description: 'x', razorpayOrderId: 'order_pending', status: 'pending', metadata: {} } as any);
    const failed = await Transaction.create({ userId: uid, type: 'credit', amount: 10, description: 'x', razorpayOrderId: 'order_failed', status: 'failed', metadata: {} } as any);
    const newUser = await mkUser();
    await setUserCreatedAt(newUser.user._id, new Date(now() - DAY));
    const oldActivated = await mkUser({ metaActivatedAt: new Date(now() - DAY) });
    await setUserCreatedAt(oldActivated.user._id, new Date(now() - 6 * DAY));
    return { old, postTop, credAt, newUser, oldActivated, preTop, welcome, debit, manual, noMarker, pend, failed };
  }

  it('window fixtures: exactly one purchase, one registration, zero activations; correct fields', async () => {
    const f = await seedFixtures();
    const r = await reconcileMetaEvents();
    const rows = await outboxRows();
    const purchases = rows.filter((x) => x.eventName === 'Purchase');
    const regs = rows.filter((x) => x.eventName === 'CompleteRegistration');
    const acts = rows.filter((x) => x.eventName === 'Activated');
    expect(purchases).toHaveLength(1);
    expect(purchases[0].eventId).toBe(`purchase_${f.postTop._id}`);
    expect(purchases[0].value).toBe(10);
    expect(purchases[0].currency).toBe('USD');
    expect(purchases[0].eventTime).toBe(Math.floor(f.credAt.getTime() / 1000));
    expect(regs).toHaveLength(1);
    expect(regs[0].eventId).toBe(`reg_${f.newUser.user._id}`);
    expect(acts).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(r.purchases).toBe(1);
    expect(r.registrations).toBe(1);
    expect(r.activations).toBe(0);
  });

  it('idempotent: a second run adds no rows', async () => {
    await seedFixtures();
    await reconcileMetaEvents();
    const first = await outboxRows();
    const r2 = await reconcileMetaEvents();
    const second = await outboxRows();
    expect(second).toHaveLength(first.length);
    expect(r2).toEqual({ purchases: 0, registrations: 0, activations: 0 });
  });

  it('does not duplicate rows the live path already enqueued', async () => {
    metaOn(new Date(Date.now() - 3 * DAY).toISOString());
    const res = await signupReq({ email: 'live@example.com', password: 'pw12345678' });
    expect(res.body.metaEventId).toBeTruthy();
    await reconcileMetaEvents();
    await reconcileMetaEvents();
    expect(await outboxRows({ eventId: res.body.metaEventId })).toHaveLength(1);
  });

  it('window = max(START_AT, now-7d): a top-up credited 10d ago is excluded even with START_AT 30d ago; 6d ago is included', async () => {
    metaOn(new Date(now() - 30 * DAY).toISOString());
    const { user } = await mkUser();
    await setUserCreatedAt(user._id, new Date(now() - 20 * DAY));
    const mk = (oid: string, ago: number) =>
      Transaction.create({ userId: user._id, type: 'credit', amount: 10, description: 'x', razorpayOrderId: oid, status: 'completed',
        metadata: { walletCredited: true, walletCreditedAt: new Date(now() - ago) } } as any) as any;
    const tOld = await mk('order_10d', 10 * DAY);
    const tNew = await mk('order_6d', 6 * DAY);
    await reconcileMetaEvents();
    const ids = (await outboxRows({ eventName: 'Purchase' })).map((r) => r.eventId);
    expect(ids).toEqual([`purchase_${tNew._id}`]);
    expect(ids).not.toContain(`purchase_${tOld._id}`);
    // and a user created 10d ago (inside START_AT, outside 7d) is not registered
    expect(await outboxRows({ eventName: 'CompleteRegistration' })).toHaveLength(0);
  });

  it('START_AT boundary for purchases: credited exactly at START_AT is included; 1s before is not', async () => {
    const start = new Date(now() - 2 * DAY);
    metaOn(start.toISOString());
    const { user } = await mkUser();
    await setUserCreatedAt(user._id, new Date(now() - 6 * DAY));
    const mk = (oid: string, at: Date) =>
      Transaction.create({ userId: user._id, type: 'credit', amount: 10, description: 'x', razorpayOrderId: oid, status: 'completed',
        metadata: { walletCredited: true, walletCreditedAt: at } } as any) as any;
    const before = await mk('order_before', new Date(start.getTime() - 1000));
    const at = await mk('order_at', start);
    await reconcileMetaEvents();
    const ids = (await outboxRows({ eventName: 'Purchase' })).map((r) => r.eventId);
    expect(ids).not.toContain(`purchase_${before._id}`);
    expect(ids).toContain(`purchase_${at._id}`);
  });

  it('user created after START_AT who later activated -> reconciler recovers act_ row (eventTime = metaActivatedAt)', async () => {
    metaOn(new Date(now() - 3 * DAY).toISOString());
    const activatedAt = new Date(now() - 3600_000);
    const { user } = await mkUser({ metaActivatedAt: activatedAt });
    await setUserCreatedAt(user._id, new Date(now() - DAY));
    await reconcileMetaEvents();
    const acts = await outboxRows({ eventName: 'Activated' });
    expect(acts).toHaveLength(1);
    expect(acts[0].eventId).toBe(`act_${user._id}`);
    expect(acts[0].eventTime).toBe(Math.floor(activatedAt.getTime() / 1000));
    expect(String(acts[0].eventSourceUrl)).toMatch(/\/today$/);
    await reconcileMetaEvents();
    expect(await outboxRows({ eventName: 'Activated' })).toHaveLength(1);
  });

  it('user created after START_AT with no metaActivatedAt -> no act_ row', async () => {
    metaOn(new Date(now() - 3 * DAY).toISOString());
    const { user } = await mkUser();
    await setUserCreatedAt(user._id, new Date(now() - DAY));
    await reconcileMetaEvents();
    expect(await outboxRows({ eventName: 'Activated' })).toHaveLength(0);
    expect(await outboxRows({ eventId: `reg_${user._id}` })).toHaveLength(1);
  });

  it('recovered rows carry hashed identifiers only (no raw email)', async () => {
    const f = await seedFixtures();
    await reconcileMetaEvents();
    const rows = await outboxRows();
    const blob = JSON.stringify(rows).toLowerCase();
    expect(blob).not.toContain(String(f.old.user.email).toLowerCase());
    expect(blob).not.toContain(String(f.newUser.user.email).toLowerCase());
    const reg = rows.find((r) => r.eventName === 'CompleteRegistration');
    expect(reg.userData.em).toBe(sha256(String(f.newUser.user.email).trim().toLowerCase()));
  });

  it('reconciler with no data does nothing and does not throw', async () => {
    metaOn();
    await expect(reconcileMetaEvents()).resolves.toEqual({ purchases: 0, registrations: 0, activations: 0 });
  });
});
