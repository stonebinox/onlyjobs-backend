// 6a4p adversarial: S5 Activation (+ hasVisibleBriefMatch contract, S1 gating on activation).
// Oracle = bd task requirements only. Implementation bodies were not read.
// Time boundaries: Mongo + HTTP latency means "exactly 15d" cannot be pinned without faking the
// clock, so 15d is probed with a +/-60s margin (inside = 15d-60s old, outside = 15d+60s old).
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
jest.mock('../services/matchingService');

import request from 'supertest';
import {
  app, metaOn, metaOff, saveMetaEnv, restoreMetaEnv, mkUser, setUserCreatedAt, outboxRows, breakOutbox,
  User, Transaction, MetaEventOutbox, DAY, EMPTY_RESUME, GO_LIVE, tokenFor, mongoose,
} from './6a4p.helpers';
import MatchRecord from '../models/MatchRecord';
import JobListing from '../models/JobListing';
import { hasVisibleBriefMatch } from '../utils/todayEligibility';
import * as matchingService from '../services/matchingService';

let jobSeq = 0;
async function mkJob() {
  jobSeq += 1;
  return (await JobListing.create({
    title: `Job ${jobSeq}`, company: `Co ${jobSeq}`, location: ['Remote'], source: 'test',
    description: 'desc', url: `https://example.com/jobs/${jobSeq}-${Date.now()}`,
  })) as any;
}

interface RecOpts {
  score?: number;
  ageMs?: number;
  skipped?: boolean;
  clicked?: boolean;
  applied?: boolean | null | 'unset';
  deleteJob?: boolean;
}
async function mkMatch(userId: unknown, o: RecOpts = {}) {
  const job = await mkJob();
  const doc: any = {
    userId, jobId: job._id, matchScore: o.score ?? 80, verdict: 'ok', reasoning: 'r',
    skipped: o.skipped ?? false, clicked: o.clicked ?? false,
  };
  if (o.applied !== 'unset') doc.applied = o.applied === undefined ? null : o.applied;
  const rec: any = await MatchRecord.create(doc);
  const set: any = { createdAt: new Date(Date.now() - (o.ageMs ?? 1000)) };
  const upd: any = { $set: set };
  if (o.applied === 'unset') upd.$unset = { applied: '' };
  await MatchRecord.collection.updateOne({ _id: rec._id }, upd);
  if (o.deleteJob) await JobListing.deleteOne({ _id: job._id });
  return rec;
}

const activate = (token: string) =>
  request(app).post('/api/matches/activation').set('Authorization', `Bearer ${token}`).send({});
const actRows = () => outboxRows({ eventName: 'Activated' });
const reload = (id: unknown) => User.findById(id).lean() as unknown as Promise<any>;

beforeAll(async () => {
  await MetaEventOutbox.syncIndexes();
  await MatchRecord.syncIndexes();
});
beforeEach(() => {
  saveMetaEnv();
  metaOn();
  jest.clearAllMocks();
});
afterEach(() => {
  restoreMetaEnv();
  jest.restoreAllMocks();
});

describe('S5 eligibility', () => {
  it('unauthenticated -> 401, nothing written', async () => {
    const res = await request(app).post('/api/matches/activation').send({});
    expect(res.status).toBe(401);
    expect(await actRows()).toHaveLength(0);
  });

  it('happy path: claims once, act_<id>, Activated row with eventTime=metaActivatedAt secs and /today source url', async () => {
    const { user, token } = await mkUser();
    await mkMatch(user._id);
    const res = await activate(token);
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(res.body.metaEventId).toBe(`act_${user._id}`);
    const u = await reload(user._id);
    expect(u.metaActivatedAt).toBeInstanceOf(Date);
    const rows = await actRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(`act_${user._id}`);
    expect(String(rows[0].userId)).toBe(String(user._id));
    expect(rows[0].eventTime).toBe(Math.floor(new Date(u.metaActivatedAt).getTime() / 1000));
    expect(String(rows[0].eventSourceUrl)).toMatch(/\/today$/);
    expect(rows[0].status).toBe('pending');
  });

  it('second call: alreadyActivated with the SAME metaEventId; no new row; metaActivatedAt unchanged', async () => {
    const { user, token } = await mkUser();
    await mkMatch(user._id);
    await activate(token);
    const before = await reload(user._id);
    const res = await activate(token);
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(false);
    expect(res.body.alreadyActivated).toBe(true);
    expect(res.body.metaEventId).toBe(`act_${user._id}`);
    const after = await reload(user._id);
    expect(new Date(after.metaActivatedAt).getTime()).toBe(new Date(before.metaActivatedAt).getTime());
    expect(await actRows()).toHaveLength(1);
  });

  it('concurrent x10: exactly one claim (one activated:true), one metaActivatedAt, <=1 act_ row (==1 here)', async () => {
    const { user, token } = await mkUser();
    await mkMatch(user._id);
    const results = await Promise.all(Array.from({ length: 10 }, () => activate(token)));
    for (const r of results) expect(r.status).toBe(200);
    expect(results.filter((r) => r.body.activated === true)).toHaveLength(1);
    const dupes = results.filter((r) => r.body.activated === false);
    for (const r of dupes) {
      expect(r.body.alreadyActivated).toBe(true);
      expect(r.body.metaEventId).toBe(`act_${user._id}`);
    }
    expect(await actRows()).toHaveLength(1);
    expect((await reload(user._id)).metaActivatedAt).toBeTruthy();
  });

  it('no resume -> {activated:false, reason:no_resume}; no claim, no row (even with a visible match)', async () => {
    for (const resume of [EMPTY_RESUME, { skills: [], experience: [], education: [], summary: '' }, { skills: ['  '], experience: [''] }]) {
      const { user, token } = await mkUser({ resume });
      await mkMatch(user._id);
      const res = await activate(token);
      expect(res.status).toBe(200);
      expect(res.body.activated).toBe(false);
      expect(res.body.reason).toBe('no_resume');
      expect((await reload(user._id)).metaActivatedAt).toBeUndefined();
    }
    expect(await actRows()).toHaveLength(0);
  });

  it('resume with only a skill (no summary) is meaningful', async () => {
    const { user, token } = await mkUser({ resume: { skills: ['go'], experience: [], education: [], summary: '' } });
    await mkMatch(user._id);
    const res = await activate(token);
    expect(res.body.activated).toBe(true);
  });

  it('resume ok but zero matches -> no_visible_match', async () => {
    const { user, token } = await mkUser();
    const res = await activate(token);
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(false);
    expect(res.body.reason).toBe('no_visible_match');
    expect((await reload(user._id)).metaActivatedAt).toBeUndefined();
    expect(await actRows()).toHaveLength(0);
  });

  const invisible: Array<[string, RecOpts]> = [
    ['16 days old', { ageMs: 16 * DAY }],
    ['15d + 60s old (just outside window)', { ageMs: 15 * DAY + 60_000 }],
    ['clicked only', { clicked: true }],
    ['applied true', { applied: true }],
    ['applied false', { applied: false }],
    ['applied true AND clicked', { applied: true, clicked: true }],
    ['skipped only', { skipped: true }],
    ['job deleted', { deleteJob: true }],
    ['below default minScore (29 vs 30)', { score: 29 }],
    ['score 0', { score: 0 }],
  ];
  it.each(invisible)('only match is %s -> no claim (no_visible_match)', async (_n, o) => {
    const { user, token } = await mkUser();
    await mkMatch(user._id, o);
    const res = await activate(token);
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(false);
    expect(res.body.reason).toBe('no_visible_match');
    expect((await reload(user._id)).metaActivatedAt).toBeUndefined();
    expect(await actRows()).toHaveLength(0);
  });

  const visible: Array<[string, RecOpts]> = [
    ['fresh', {}],
    ['15d - 60s old (just inside window)', { ageMs: 15 * DAY - 60_000 }],
    ['score exactly 30 (default minScore)', { score: 30 }],
    ['applied field absent (not null, not set)', { applied: 'unset' }],
    ['applied null', { applied: null }],
  ];
  it.each(visible)('single %s match -> claims', async (_n, o) => {
    const { user, token } = await mkUser();
    await mkMatch(user._id, o);
    const res = await activate(token);
    expect(res.body.activated).toBe(true);
    expect((await reload(user._id)).metaActivatedAt).toBeTruthy();
    expect(await actRows()).toHaveLength(1);
  });

  it('one visible among many invisible -> claims', async () => {
    const { user, token } = await mkUser();
    await mkMatch(user._id, { ageMs: 20 * DAY });
    await mkMatch(user._id, { skipped: true });
    await mkMatch(user._id, { clicked: true });
    await mkMatch(user._id, { applied: false });
    await mkMatch(user._id, { score: 5 });
    await mkMatch(user._id, { deleteJob: true });
    await mkMatch(user._id, { score: 55 });
    const res = await activate(token);
    expect(res.body.activated).toBe(true);
  });

  it("another user's visible match does not count", async () => {
    const a = await mkUser();
    const b = await mkUser();
    await mkMatch(b.user._id);
    const res = await activate(a.token);
    expect(res.body.activated).toBe(false);
    expect(res.body.reason).toBe('no_visible_match');
  });

  describe('minScore boundaries', () => {
    it('custom minScore 60: score 60 claims; score 59 does not', async () => {
      const lo = await mkUser({ preferences: { minScore: 60 } });
      await mkMatch(lo.user._id, { score: 59 });
      expect((await activate(lo.token)).body.reason).toBe('no_visible_match');
      const eq = await mkUser({ preferences: { minScore: 60 } });
      await mkMatch(eq.user._id, { score: 60 });
      expect((await activate(eq.token)).body.activated).toBe(true);
    });

    it('score 30 does not count when user raised minScore to 31', async () => {
      const { user, token } = await mkUser({ preferences: { minScore: 31 } });
      await mkMatch(user._id, { score: 30 });
      expect((await activate(token)).body.reason).toBe('no_visible_match');
    });

    it('minScore explicitly 0 (falsy zero) is honoured: score 5 is visible', async () => {
      const { user, token } = await mkUser({ preferences: { minScore: 0 } });
      await User.collection.updateOne({ _id: user._id }, { $set: { 'preferences.minScore': 0 } });
      await mkMatch(user._id, { score: 5 });
      const res = await activate(token);
      expect(res.body.activated).toBe(true);
    });

    it('minScore unset (field removed): default 30 applies at the boundary (29 no, 30 yes)', async () => {
      const a = await mkUser();
      await User.collection.updateOne({ _id: a.user._id }, { $unset: { 'preferences.minScore': '' } });
      await mkMatch(a.user._id, { score: 29 });
      expect((await activate(a.token)).body.reason).toBe('no_visible_match');
      const b = await mkUser();
      await User.collection.updateOne({ _id: b.user._id }, { $unset: { 'preferences.minScore': '' } });
      await mkMatch(b.user._id, { score: 30 });
      expect((await activate(b.token)).body.activated).toBe(true);
    });
  });

  describe('hasVisibleBriefMatch(userId, minScore) direct contract', () => {
    it('window edge, filters and minScore (0 / undefined / null / equal / one-below)', async () => {
      const { user } = await mkUser();
      expect(await hasVisibleBriefMatch(user._id, 30)).toBe(false);
      await mkMatch(user._id, { score: 5 });
      expect(await hasVisibleBriefMatch(user._id, 0)).toBe(true);
      expect(await hasVisibleBriefMatch(user._id, 5)).toBe(true);
      expect(await hasVisibleBriefMatch(user._id, 6)).toBe(false);
      expect(await hasVisibleBriefMatch(user._id, undefined)).toBe(false); // default 30, score 5
      expect(await hasVisibleBriefMatch(user._id, null)).toBe(false);
      await mkMatch(user._id, { score: 30 });
      expect(await hasVisibleBriefMatch(user._id, undefined)).toBe(true);
      expect(await hasVisibleBriefMatch(user._id, null)).toBe(true);
      expect(await hasVisibleBriefMatch(String(user._id), 30)).toBe(true); // string id accepted
    });

    it('window: 15d-60s inside, 15d+60s outside', async () => {
      const a = await mkUser();
      await mkMatch(a.user._id, { ageMs: 15 * DAY - 60_000 });
      expect(await hasVisibleBriefMatch(a.user._id, 30)).toBe(true);
      const b = await mkUser();
      await mkMatch(b.user._id, { ageMs: 15 * DAY + 60_000 });
      expect(await hasVisibleBriefMatch(b.user._id, 30)).toBe(false);
    });

    it('invisible states', async () => {
      const u = await mkUser();
      await mkMatch(u.user._id, { skipped: true });
      await mkMatch(u.user._id, { clicked: true });
      await mkMatch(u.user._id, { applied: true });
      await mkMatch(u.user._id, { applied: false });
      await mkMatch(u.user._id, { deleteJob: true });
      expect(await hasVisibleBriefMatch(u.user._id, 0)).toBe(false);
    });
  });
});

describe('S5 outbox gating by user.createdAt vs META_CAPI_START_AT', () => {
  it('user created BEFORE START_AT: metaActivatedAt is set but ZERO act_ rows', async () => {
    const { user, token } = await mkUser();
    await setUserCreatedAt(user._id, new Date(Date.now() - 2 * DAY));
    metaOn(new Date(Date.now() - 3600_000).toISOString());
    await mkMatch(user._id);
    const res = await activate(token);
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect((await reload(user._id)).metaActivatedAt).toBeTruthy();
    expect(await actRows()).toHaveLength(0);
  });

  it('createdAt EXACTLY equal to START_AT -> enqueued (inclusive boundary)', async () => {
    const { user, token } = await mkUser();
    const created = (await reload(user._id)).createdAt as Date;
    metaOn(created.toISOString());
    await mkMatch(user._id);
    expect((await activate(token)).body.activated).toBe(true);
    expect(await actRows()).toHaveLength(1);
  });

  it('createdAt 1ms BEFORE START_AT -> not enqueued', async () => {
    const { user, token } = await mkUser();
    const created = (await reload(user._id)).createdAt as Date;
    metaOn(new Date(created.getTime() + 1).toISOString());
    await mkMatch(user._id);
    expect((await activate(token)).body.activated).toBe(true);
    expect(await actRows()).toHaveLength(0);
  });

  it('older user: second call is alreadyActivated and still enqueues nothing', async () => {
    const { user, token } = await mkUser();
    await setUserCreatedAt(user._id, new Date(Date.now() - 5 * DAY));
    metaOn(new Date(Date.now() - 3600_000).toISOString());
    await mkMatch(user._id);
    await activate(token);
    const r2 = await activate(token);
    expect(r2.body.alreadyActivated).toBe(true);
    expect(await actRows()).toHaveLength(0);
  });

  it.each([
    ['ENABLED unset', () => delete process.env.META_CAPI_ENABLED],
    ['ENABLED=false', () => (process.env.META_CAPI_ENABLED = 'false')],
    ['START_AT unset', () => delete process.env.META_CAPI_START_AT],
    ['START_AT invalid', () => (process.env.META_CAPI_START_AT = 'whenever')],
  ] as Array<[string, () => void]>)('gating off (%s): zero rows, endpoint still 200', async (_n, off) => {
    const { user, token } = await mkUser();
    await mkMatch(user._id);
    off();
    const res = await activate(token);
    expect(res.status).toBe(200);
    expect(await actRows()).toHaveLength(0);
  });

  it('claim succeeds (200) when the outbox insert throws', async () => {
    const { user, token } = await mkUser();
    await mkMatch(user._id);
    const brk = breakOutbox();
    const res = await activate(token);
    const calls = brk.calls();
    brk.restore();
    expect(calls).toBeGreaterThan(0);
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect((await reload(user._id)).metaActivatedAt).toBeTruthy();
  });

  it('Activated row userData is hashed, no raw email', async () => {
    const { user, token } = await mkUser();
    await mkMatch(user._id);
    await activate(token);
    const [row] = await actRows();
    expect(JSON.stringify(row).toLowerCase()).not.toContain(String(user.email).toLowerCase());
    expect(row.userData.em).toMatch(/^[a-f0-9]{64}$/);
    expect(row.userData.external_id).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('S5 endpoint is read-only with respect to matching/billing', () => {
  it('never triggers matching/scoring, never debits the wallet, never creates MatchRecords/Transactions', async () => {
    const { user, token } = await mkUser({ walletBalance: 5 });
    await mkMatch(user._id);
    const beforeMatches = await MatchRecord.countDocuments({});
    const beforeTx = await Transaction.countDocuments({});
    await activate(token);
    await activate(token);
    const mocked = matchingService as any;
    for (const [name, fn] of Object.entries(mocked)) {
      if (jest.isMockFunction(fn)) expect((fn as jest.Mock).mock.calls.length).toBe(0);
      void name;
    }
    expect(await MatchRecord.countDocuments({})).toBe(beforeMatches);
    expect(await Transaction.countDocuments({})).toBe(beforeTx);
    expect((await reload(user._id)).walletBalance).toBe(5);
  });

  it('does not mutate the MatchRecords it inspects (clicked/applied/skipped stay as-is)', async () => {
    const { user, token } = await mkUser();
    const rec = await mkMatch(user._id);
    await activate(token);
    const after: any = await MatchRecord.findById(rec._id).lean();
    expect(after.clicked).toBe(false);
    expect(after.skipped).toBe(false);
    expect(after.applied ?? null).toBeNull();
  });
});

void tokenFor; void GO_LIVE; void metaOff; void mongoose;
