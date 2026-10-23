process.env.JWT_SECRET = 'test-jwt-secret';

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: (...a: any[]) => mockCreate(...a) } },
  })),
}));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import User from '../models/User';
import JobListing from '../models/JobListing';
import MatchRecord, { Freshness } from '../models/MatchRecord';
import RejectionSignal from '../models/RejectionSignal';
import matchRoutes from '../routes/matchRoutes';
import userRoutes from '../routes/userRoutes';
import { generateToken } from '../utils/generateToken';
import { parseSignalDecision } from '../services/rejectionSignalService';
import { companyKey } from '../utils/companyHistory';

const app = express();
app.use(express.json());
app.use('/api/matches', matchRoutes);
app.use('/api/users', userRoutes);
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(res.statusCode !== 200 ? res.statusCode : 500).json({ error: err.message })
);

const DAY = 24 * 3600 * 1000;
let seq = 0;

// ---- model routing: learning call vs anything else
let learnReply: () => any;
const learnCalls = () =>
  mockCreate.mock.calls.filter((c) => JSON.stringify(c[0]).includes('updatedInsights')).length;

function setDecision(signal: any, updatedInsights: any = 'NEW-INSIGHTS') {
  const body: any = {};
  if (updatedInsights !== null) body.updatedInsights = updatedInsights;
  if (signal !== undefined) body.signal = signal;
  learnReply = () => ({
    choices: [{ message: { content: JSON.stringify(body) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  });
}

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockImplementation(async () => learnReply());
  setDecision({ scope: 'company', duration: 'permanent', rationale: 'r' });
  delete process.env.REJECTION_BLOCKS_ENABLED;
});

async function mkUser(extra: any = {}) {
  seq++;
  const u = await User.create({
    name: `U${seq}`, email: `u${seq}-${Date.now()}@t.com`, password: 'pw123456', isVerified: true,
    walletBalance: 5,
    learnedPreferences: { insights: 'OLD-INSIGHTS', lastUpdated: new Date(), feedbackCount: 0 },
    ...extra,
  });
  return { user: u, token: generateToken(u._id.toString()) };
}
async function mkMatch(userId: any, company: string, title = 'Software Engineer') {
  seq++;
  const job = await JobListing.create({
    title, company, location: ['Remote'], source: 'test', description: 'd', url: `https://x.com/${seq}-${Math.random()}`,
    postedDate: new Date(), scrapedDate: new Date(),
  });
  const match = await MatchRecord.create({
    userId, jobId: job._id, matchScore: 80, verdict: 'Good', reasoning: 'ok', freshness: Freshness.FRESH,
    clicked: false, skipped: false, applied: null,
  });
  return { job, match };
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const skip = (t: string, matchId: any, reason = 'other', details?: string) =>
  request(app).post('/api/matches/skip').set(auth(t)).send({ matchId: String(matchId), reason, details });
const notApplied = (t: string, matchId: any, reason = 'other', details?: string) =>
  request(app).post('/api/matches/applied').set(auth(t)).send({ matchId: String(matchId), applied: false, reason, details });

async function waitRows(filter: any, n = 1, ms = 3000) {
  const end = Date.now() + ms;
  let rows: any[] = [];
  while (Date.now() < end) {
    rows = await RejectionSignal.find(filter);
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return rows;
}
const settle = () => new Promise((r) => setTimeout(r, 150));

async function seedSignal(userId: any, over: any = {}) {
  seq++;
  const matchId = over.matchId || new mongoose.Types.ObjectId();
  const company = over.company || 'Camunda';
  const doc: any = await RejectionSignal.create({
    userId, matchId, jobId: new mongoose.Types.ObjectId(), source: 'skip', category: 'other',
    company, companyKey: companyKey(company), title: 'Software Engineer', roleKey: 'software engineer',
    scope: 'company', duration: 'permanent', blockedUntil: null, status: 'active', analysisStatus: 'ok',
    ...over,
  });
  if (over.createdAt) await RejectionSignal.collection.updateOne({ _id: doc._id }, { $set: { createdAt: over.createdAt } });
  return doc;
}

describe('R1 persistence + idempotency', () => {
  it('skip persists exactly one signal with snapshot fields', async () => {
    const { user, token } = await mkUser();
    const { job, match } = await mkMatch(user._id, 'Camunda', 'Senior Software Engineer II');
    const res = await skip(token, match._id, 'other', "applied too many times, can't apply again for 30 days");
    expect(res.status).toBe(200);
    const rows = await waitRows({ matchId: match._id });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.source).toBe('skip');
    expect(String(r.userId)).toBe(String(user._id));
    expect(String(r.jobId)).toBe(String(job._id));
    expect(r.company).toBe('Camunda');
    expect(r.companyKey).toBe(companyKey('Camunda'));
    expect(r.title).toBe('Senior Software Engineer II');
    expect(r.roleKey).toBe('software engineer');
    expect(r.category).toBe('other');
    expect(r.details).toBe("applied too many times, can't apply again for 30 days");
    expect(r.status).toBe('active');
  });

  it('applied:false persists source not_applied', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Tether');
    const res = await notApplied(token, match._id, 'other', 'tedious application process');
    expect(res.status).toBe(200);
    const rows = await waitRows({ matchId: match._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('not_applied');
    expect(rows[0].details).toBe('tedious application process');
    expect(rows[0].companyKey).toBe(companyKey('Tether'));
  });

  it('exactly one OpenAI chat call per rejection (skip and not_applied)', async () => {
    const { user, token } = await mkUser();
    const a = await mkMatch(user._id, 'Camunda');
    const b = await mkMatch(user._id, 'Tether');
    await skip(token, a.match._id, 'other', 'x');
    await waitRows({ matchId: a.match._id });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(learnCalls()).toBe(1);
    await notApplied(token, b.match._id, 'other', 'y');
    await waitRows({ matchId: b.match._id });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('repeat sequential request: one row, createdAt unchanged', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    await skip(token, match._id, 'other', 'x');
    const [first] = await waitRows({ matchId: match._id });
    const created = first.createdAt.getTime();
    await new Promise((r) => setTimeout(r, 30));
    const res2 = await skip(token, match._id, 'other', 'x');
    expect(res2.status).toBeLessThan(500);
    await settle();
    const rows = await RejectionSignal.find({ matchId: match._id, source: 'skip' });
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt.getTime()).toBe(created);
  });

  it('concurrent double-submit yields one row and no 5xx', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    const rs = await Promise.all([skip(token, match._id, 'other', 'x'), skip(token, match._id, 'other', 'x')]);
    rs.forEach((r) => expect(r.status).toBeLessThan(500));
    await settle();
    expect(await RejectionSignal.countDocuments({ matchId: match._id, source: 'skip' })).toBe(1);
  });

  it('repeat applied:false: one row', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    await notApplied(token, match._id, 'other', 'x');
    await waitRows({ matchId: match._id });
    await notApplied(token, match._id, 'other', 'x');
    await settle();
    expect(await RejectionSignal.countDocuments({ matchId: match._id, source: 'not_applied' })).toBe(1);
  });
});

describe('R2/R3 decision parsing + fail-open', () => {
  it('stores the AI decision and updates insights from the same call', async () => {
    setDecision({ scope: 'attribute', attribute: 'avoids Indian companies', duration: 'permanent', rationale: 'pref' }, 'I avoid Indian companies');
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Zinnia');
    const res = await skip(token, match._id, 'other', 'I avoid Indian companies');
    expect(res.status).toBe(200);
    const [r] = await waitRows({ matchId: match._id });
    expect(r.scope).toBe('attribute');
    expect(r.attribute).toBe('avoids Indian companies');
    expect(r.duration).toBe('permanent');
    expect(r.analysisStatus).toBe('ok');
    expect(r.rationale).toBe('pref');
    expect(r.blockedUntil ?? null).toBeNull();
    const u = await User.findById(user._id);
    expect(u!.learnedPreferences!.insights).toBe('I avoid Indian companies');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  const invalid: [string, any][] = [
    ['missing signal', undefined],
    ['null signal', null],
    ['string signal', 'company'],
    ['unknown scope', { scope: 'galaxy', duration: 'permanent' }],
    ['unknown duration', { scope: 'company', duration: 'forever' }],
    ['non-numeric cooldownDays', { scope: 'company', duration: 'temporary', cooldownDays: 'thirty' }],
    ['company with duration none', { scope: 'company', duration: 'none' }],
    ['role with duration none', { scope: 'role', duration: 'none' }],
    ['attribute with duration none', { scope: 'attribute', attribute: 'x', duration: 'none' }],
  ];
  it.each(invalid)('invalid decision (%s) => failed/none/none, HTTP 200, insights still updated, signal null', async (_n, sig) => {
    setDecision(sig, 'VALID-INSIGHTS');
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Ashby');
    const res = await skip(token, match._id, 'other', 'they already rejected me');
    expect(res.status).toBe(200);
    const [r] = await waitRows({ matchId: match._id });
    expect(r.analysisStatus).toBe('failed');
    expect(r.scope).toBe('none');
    expect(r.duration).toBe('none');
    expect(r.blockedUntil ?? null).toBeNull();
    expect(res.body.signal).toBeNull();
    const u = await User.findById(user._id);
    expect(u!.learnedPreferences!.insights).toBe('VALID-INSIGHTS');
  });

  it('OpenAI throwing => 200, skip saved, no active blocking signal', async () => {
    mockCreate.mockImplementation(async () => { throw new Error('boom'); });
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Tether');
    const res = await skip(token, match._id, 'other', 'tedious');
    expect(res.status).toBe(200);
    await settle();
    const m = await MatchRecord.findById(match._id);
    expect(m!.skipped).toBe(true);
    expect(res.body.signal ?? null).toBeNull();
    const rows = await RejectionSignal.find({ matchId: match._id });
    rows.forEach((r) => { expect(r.scope).toBe('none'); expect(r.analysisStatus).not.toBe('ok'); });
  });

  it('OpenAI throwing on applied:false => 200 and answer saved', async () => {
    mockCreate.mockImplementation(async () => { throw new Error('boom'); });
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Tether');
    const res = await notApplied(token, match._id, 'other', 'tedious');
    expect(res.status).toBe(200);
    const m = await MatchRecord.findById(match._id);
    expect(m!.applied).toBe(false);
    expect(m!.notAppliedReason?.category).toBe('other');
  });

  it('non-JSON model content => 200', async () => {
    learnReply = () => ({ choices: [{ message: { content: 'not json at all' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Tether');
    const res = await skip(token, match._id, 'other', 'x');
    expect(res.status).toBe(200);
    const m = await MatchRecord.findById(match._id);
    expect(m!.skipped).toBe(true);
  });

  it('invalid updatedInsights does not clobber existing insights', async () => {
    setDecision({ scope: 'company', duration: 'permanent' }, null);
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Tether');
    const res = await skip(token, match._id, 'other', 'x');
    expect(res.status).toBe(200);
    await settle();
    const u = await User.findById(user._id);
    expect(u!.learnedPreferences!.insights).toBe('OLD-INSIGHTS');
  });
});

describe('parseSignalDecision', () => {
  it.each([undefined, null, 'x', 5, [], {}])('garbage %p => failed none none', (raw) => {
    const d = parseSignalDecision(raw as any);
    expect(d.analysisStatus).toBe('failed');
    expect(d.scope).toBe('none');
    expect(d.duration).toBe('none');
  });
  it('none/none is a valid ok decision', () => {
    const d = parseSignalDecision({ scope: 'none', duration: 'none' });
    expect(d.analysisStatus).toBe('ok');
    expect(d.scope).toBe('none');
  });
  it('valid company permanent is ok', () => {
    const d = parseSignalDecision({ scope: 'company', duration: 'permanent', rationale: 'because' });
    expect(d).toMatchObject({ analysisStatus: 'ok', scope: 'company', duration: 'permanent' });
  });
  it('company+none and unknown enums fail', () => {
    expect(parseSignalDecision({ scope: 'company', duration: 'none' }).analysisStatus).toBe('failed');
    expect(parseSignalDecision({ scope: 'COMPANY', duration: 'permanent' }).analysisStatus).toBe('failed');
    expect(parseSignalDecision({ scope: 'company', duration: 'temporary', cooldownDays: 'x' }).analysisStatus).toBe('failed');
    expect(parseSignalDecision({ scope: 'company', duration: 'temporary', cooldownDays: NaN }).analysisStatus).toBe('failed');
  });
});

describe('R4 cooldown clamp + blockedUntil', () => {
  const cases: [any, number][] = [[6, 7], [7, 7], [8, 8], [179, 179], [180, 180], [181, 180], [0, 7], [-5, 7], [100000, 180]];
  it.each(cases)('cooldownDays %p => %p', async (input, expected) => {
    setDecision({ scope: 'company', duration: 'temporary', cooldownDays: input });
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    const res = await skip(token, match._id, 'other', 'x');
    expect(res.status).toBe(200);
    const [r] = await waitRows({ matchId: match._id });
    expect(r.analysisStatus).toBe('ok');
    expect(r.cooldownDays).toBe(expected);
    const delta = r.blockedUntil!.getTime() - r.createdAt.getTime();
    expect(Math.abs(delta - expected * DAY)).toBeLessThan(10_000);
  });

  it('temporary without cooldownDays => 30 days', async () => {
    setDecision({ scope: 'company', duration: 'temporary' });
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    await skip(token, match._id, 'other', 'x');
    const [r] = await waitRows({ matchId: match._id });
    expect(r.cooldownDays).toBe(30);
    expect(Math.abs(r.blockedUntil!.getTime() - r.createdAt.getTime() - 30 * DAY)).toBeLessThan(10_000);
  });

  it('permanent and none have null blockedUntil even if cooldownDays supplied', async () => {
    setDecision({ scope: 'company', duration: 'permanent', cooldownDays: 40 });
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    await skip(token, match._id, 'other', 'x');
    const [r] = await waitRows({ matchId: match._id });
    expect(r.blockedUntil ?? null).toBeNull();
  });
});

describe('R5 job_inactive', () => {
  it('no OpenAI call, skipped row, null signal, 200', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    const res = await skip(token, match._id, 'job_inactive');
    expect(res.status).toBe(200);
    const [r] = await waitRows({ matchId: match._id });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(r.analysisStatus).toBe('skipped');
    expect(r.scope).toBe('none');
    expect(r.category).toBe('job_inactive');
    expect(res.body.signal).toBeNull();
  });
  it('job_inactive via applied:false also makes no call', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    const res = await notApplied(token, match._id, 'job_inactive');
    expect(res.status).toBe(200);
    const [r] = await waitRows({ matchId: match._id });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(r.analysisStatus).toBe('skipped');
    expect(r.source).toBe('not_applied');
  });
});

describe('R6 repeat-rejection override', () => {
  async function prior(userId: any, ageDays: number, over: any = {}) {
    return seedSignal(userId, { company: 'Sanctuary Computer', scope: 'role', duration: 'permanent', createdAt: new Date(Date.now() - ageDays * DAY), ...over });
  }
  async function run(decision: any, category = 'other') {
    setDecision(decision);
    const { user, token } = await mkUser();
    return { user, token };
  }
  async function reject(user: any, token: string, category = 'other') {
    const { match } = await mkMatch(user._id, 'Sanctuary Computer', 'Designer');
    const res = await skip(token, match._id, category, 'garden3d funnel, not a real job');
    expect(res.status).toBe(200);
    const [r] = await waitRows({ matchId: match._id });
    return { r, res };
  }

  it('2 recent others => scope forced company, AI duration kept', async () => {
    const { user, token } = await run({ scope: 'role', duration: 'temporary', cooldownDays: 20 });
    await prior(user._id, 1); await prior(user._id, 2);
    const { r, res } = await reject(user, token);
    expect(r.scope).toBe('company');
    expect(r.duration).toBe('temporary');
    expect(r.cooldownDays).toBe(20);
    expect(res.body.signal).toMatchObject({ scope: 'company', duration: 'temporary', company: 'Sanctuary Computer' });
  });

  it('AI duration none (scope none) => company temporary 30d', async () => {
    const { user, token } = await run({ scope: 'none', duration: 'none' });
    await prior(user._id, 1); await prior(user._id, 2);
    const { r } = await reject(user, token);
    expect(r.scope).toBe('company');
    expect(r.duration).toBe('temporary');
    expect(Math.abs(r.blockedUntil!.getTime() - r.createdAt.getTime() - 30 * DAY)).toBeLessThan(10_000);
  });

  it('only 1 other => no override', async () => {
    const { user, token } = await run({ scope: 'role', duration: 'permanent' });
    await prior(user._id, 1);
    const { r } = await reject(user, token);
    expect(r.scope).toBe('role');
  });

  it('44 days counts, 46 days does not', async () => {
    const a = await run({ scope: 'role', duration: 'permanent' });
    await prior(a.user._id, 44); await prior(a.user._id, 44);
    expect((await reject(a.user, a.token)).r.scope).toBe('company');
    const b = await run({ scope: 'role', duration: 'permanent' });
    await prior(b.user._id, 46); await prior(b.user._id, 46);
    expect((await reject(b.user, b.token)).r.scope).toBe('role');
  });

  it('one 44d + one 46d => only one counts => no override', async () => {
    const { user, token } = await run({ scope: 'role', duration: 'permanent' });
    await prior(user._id, 44); await prior(user._id, 46);
    expect((await reject(user, token)).r.scope).toBe('role');
  });

  it('revoked priors do not count', async () => {
    const { user, token } = await run({ scope: 'role', duration: 'permanent' });
    await prior(user._id, 1, { status: 'revoked', revokedAt: new Date() }); await prior(user._id, 2);
    expect((await reject(user, token)).r.scope).toBe('role');
  });

  it('location/salary priors do not count', async () => {
    const { user, token } = await run({ scope: 'role', duration: 'permanent' });
    await prior(user._id, 1, { category: 'location' }); await prior(user._id, 2, { category: 'salary' });
    expect((await reject(user, token)).r.scope).toBe('role');
  });

  it('priors at a different company or other user do not count', async () => {
    const { user, token } = await run({ scope: 'role', duration: 'permanent' });
    const other = await mkUser();
    await prior(user._id, 1, { company: 'Tether' });
    await prior(other.user._id, 1); await prior(other.user._id, 2);
    expect((await reject(user, token)).r.scope).toBe('role');
  });

  it('this rejection being location/salary => no override', async () => {
    const { user, token } = await run({ scope: 'role', duration: 'permanent' });
    await prior(user._id, 1); await prior(user._id, 2);
    expect((await reject(user, token, 'location')).r.scope).toBe('role');
  });

  it('failed analysis => no override (stays none)', async () => {
    const { user, token } = await run({ scope: 'bogus', duration: 'permanent' });
    await prior(user._id, 1); await prior(user._id, 2);
    const { r } = await reject(user, token);
    expect(r.analysisStatus).toBe('failed');
    expect(r.scope).toBe('none');
  });

  it('company key matches across name variants (Duck Duck Go vs DuckDuckGo)', async () => {
    setDecision({ scope: 'role', duration: 'permanent' });
    const { user, token } = await mkUser();
    await seedSignal(user._id, { company: 'Duck Duck Go', scope: 'role', createdAt: new Date(Date.now() - DAY) });
    await seedSignal(user._id, { company: 'DuckDuckGo', scope: 'role', createdAt: new Date(Date.now() - 2 * DAY) });
    const { match } = await mkMatch(user._id, 'DuckDuckGo Inc.');
    await skip(token, match._id, 'other', 'x');
    const [r] = await waitRows({ matchId: match._id });
    expect(r.scope).toBe('company');
  });
});

describe('R7 response shape', () => {
  it('skip returns message + signal object for active decision', async () => {
    setDecision({ scope: 'company', duration: 'temporary', cooldownDays: 30 });
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    const res = await skip(token, match._id, 'other', "can't apply again for 30 days");
    expect(typeof res.body.message).toBe('string');
    expect(res.body.signal).toMatchObject({ scope: 'company', company: 'Camunda', duration: 'temporary' });
    expect(new Date(res.body.signal.blockedUntil).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  });
  it('permanent => blockedUntil null', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    const res = await notApplied(token, match._id, 'other', 'x');
    expect(res.body.signal).toMatchObject({ scope: 'company', duration: 'permanent', blockedUntil: null });
    expect(typeof res.body.message).toBe('string');
  });
  it('scope none => null (location example)', async () => {
    setDecision({ scope: 'none', duration: 'none' });
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Somecorp');
    const res = await skip(token, match._id, 'location', 'Hiring within the US only');
    expect(res.status).toBe(200);
    expect(res.body.signal).toBeNull();
    expect(typeof res.body.message).toBe('string');
  });
  it('no reason given => signal null, no row, no OpenAI call', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    const res = await request(app).post('/api/matches/applied').set(auth(token)).send({ matchId: String(match._id), applied: false });
    expect(res.status).toBeLessThan(500);
    expect(res.body.signal ?? null).toBeNull();
    await settle();
    expect(await RejectionSignal.countDocuments({ matchId: match._id })).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('R8 revocation', () => {
  async function setup() {
    const { user, token } = await mkUser();
    const a = await mkMatch(user._id, 'Camunda');
    const b = await mkMatch(user._id, 'Camunda', 'Backend Engineer');
    const c = await mkMatch(user._id, 'Tether');
    const sA = await seedSignal(user._id, { matchId: a.match._id, jobId: a.job._id, company: 'Camunda', scope: 'company' });
    const sB = await seedSignal(user._id, { matchId: b.match._id, jobId: b.job._id, company: 'Camunda', scope: 'company_role', roleKey: 'backend engineer' });
    const sBattr = await seedSignal(user._id, { matchId: b.match._id, jobId: b.job._id, source: 'not_applied', company: 'Camunda', scope: 'attribute', attribute: 'x' });
    const sC = await seedSignal(user._id, { matchId: c.match._id, jobId: c.job._id, company: 'Tether', scope: 'company' });
    const other = await mkUser();
    const o = await mkMatch(other.user._id, 'Camunda');
    const sO = await seedSignal(other.user._id, { matchId: o.match._id, jobId: o.job._id, company: 'Camunda', scope: 'company' });
    return { user, token, a, b, c, o, sA, sB, sBattr, sC, sO, other };
  }
  const status = async (s: any) => (await RejectionSignal.findById(s._id))!;

  it('unskip revokes own + same-company company/company_role signals; rows kept; others untouched', async () => {
    const x = await setup();
    await MatchRecord.updateOne({ _id: x.a.match._id }, { skipped: true, skipReason: { category: 'other' } });
    await User.updateOne({ _id: x.user._id }, { $push: { skippedJobs: x.a.job._id } });
    const res = await request(app).post('/api/matches/unskip').set(auth(x.token)).send({ matchId: String(x.a.match._id) });
    expect(res.status).toBe(200);
    const A = await status(x.sA), B = await status(x.sB);
    expect(A.status).toBe('revoked'); expect(A.revokedAt).toBeTruthy();
    expect(B.status).toBe('revoked'); expect(B.revokedAt).toBeTruthy();
    expect((await status(x.sC)).status).toBe('active');
    expect((await status(x.sO)).status).toBe('active');
    expect((await status(x.sBattr)).status).toBe('active'); // attribute scope on another match is not a company block
    expect(await RejectionSignal.countDocuments({ userId: x.user._id })).toBe(4);
  });

  it('applied:true revokes', async () => {
    const x = await setup();
    const res = await request(app).post('/api/matches/applied').set(auth(x.token)).send({ matchId: String(x.a.match._id), applied: true });
    expect(res.status).toBe(200);
    expect((await status(x.sA)).status).toBe('revoked');
    expect((await status(x.sB)).status).toBe('revoked');
    expect((await status(x.sC)).status).toBe('active');
    expect((await status(x.sO)).status).toBe('active');
  });

  it('revoke-block returns count and revokes both', async () => {
    const x = await setup();
    const res = await request(app).post('/api/matches/revoke-block').set(auth(x.token)).send({ matchId: String(x.a.match._id) });
    expect(res.status).toBe(200);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.revoked).toBe(2);
    expect((await status(x.sA)).status).toBe('revoked');
    expect((await status(x.sB)).status).toBe('revoked');
    expect((await status(x.sC)).status).toBe('active');
    expect((await status(x.sO)).status).toBe('active');
  });

  it('revoke-block is idempotent: second call revokes 0', async () => {
    const x = await setup();
    await request(app).post('/api/matches/revoke-block').set(auth(x.token)).send({ matchId: String(x.a.match._id) });
    const res = await request(app).post('/api/matches/revoke-block').set(auth(x.token)).send({ matchId: String(x.a.match._id) });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(0);
  });

  it('revoke-block with no signals => revoked 0', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Lonely');
    const res = await request(app).post('/api/matches/revoke-block').set(auth(token)).send({ matchId: String(match._id) });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(0);
  });

  it('revoke-block on another user match => 403, nothing revoked', async () => {
    const x = await setup();
    const res = await request(app).post('/api/matches/revoke-block').set(auth(x.token)).send({ matchId: String(x.o.match._id) });
    expect(res.status).toBe(403);
    expect((await status(x.sO)).status).toBe('active');
  });

  it('revoke-block unknown match => 404; unauthenticated => 401', async () => {
    const { token } = await mkUser();
    const res = await request(app).post('/api/matches/revoke-block').set(auth(token)).send({ matchId: String(new mongoose.Types.ObjectId()) });
    expect(res.status).toBe(404);
    const res2 = await request(app).post('/api/matches/revoke-block').send({ matchId: String(new mongoose.Types.ObjectId()) });
    expect(res2.status).toBe(401);
  });

  it('click does NOT revoke', async () => {
    const x = await setup();
    const res = await request(app).post('/api/matches/click').set(auth(x.token)).send({ matchId: String(x.a.match._id) });
    expect(res.status).toBeLessThan(500);
    expect((await status(x.sA)).status).toBe('active');
    expect((await status(x.sB)).status).toBe('active');
  });

  it('revoked company: a later non-matching rejection at same company count not affected (revoked priors excluded)', async () => {
    const x = await setup();
    await request(app).post('/api/matches/revoke-block').set(auth(x.token)).send({ matchId: String(x.a.match._id) });
    expect((await status(x.sA)).analysisStatus).toBe('ok');
  });
});

describe('R9 re-skip after unskip', () => {
  it('skip -> unskip -> skip leaves one active row with new decision', async () => {
    const { user, token } = await mkUser();
    const { match } = await mkMatch(user._id, 'Camunda');
    setDecision({ scope: 'company', duration: 'permanent' });
    await skip(token, match._id, 'other', 'first');
    await waitRows({ matchId: match._id });
    await request(app).post('/api/matches/unskip').set(auth(token)).send({ matchId: String(match._id) });
    const mid = await RejectionSignal.findOne({ matchId: match._id });
    expect(mid!.status).toBe('revoked');
    setDecision({ scope: 'role', duration: 'temporary', cooldownDays: 45 });
    const res = await skip(token, match._id, 'role_mismatch', 'second');
    expect(res.status).toBe(200);
    await settle();
    const rows = await RejectionSignal.find({ matchId: match._id, source: 'skip' });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.status).toBe('active');
    expect(r.revokedAt ?? null).toBeNull();
    expect(r.scope).toBe('role');
    expect(r.duration).toBe('temporary');
    expect(r.cooldownDays).toBe(45);
    expect(r.category).toBe('role_mismatch');
    expect(r.details).toBe('second');
    expect(r.analysisStatus).toBe('ok');
  });
});

describe('R10 account deletion', () => {
  async function two() {
    const a = await mkUser(); const b = await mkUser();
    await seedSignal(a.user._id); await seedSignal(a.user._id, { company: 'Tether' });
    await seedSignal(b.user._id);
    return { a, b };
  }
  it('factory-reset removes only that user signals', async () => {
    const { a, b } = await two();
    const res = await request(app).post('/api/users/factory-reset').set(auth(a.token)).send({});
    expect(res.status).toBeLessThan(400);
    expect(await RejectionSignal.countDocuments({ userId: a.user._id })).toBe(0);
    expect(await RejectionSignal.countDocuments({ userId: b.user._id })).toBe(1);
  });
  it('delete account removes only that user signals', async () => {
    const { a, b } = await two();
    const res = await request(app).delete('/api/users/delete').set(auth(a.token)).send({});
    expect(res.status).toBeLessThan(400);
    expect(await RejectionSignal.countDocuments({ userId: a.user._id })).toBe(0);
    expect(await RejectionSignal.countDocuments({ userId: b.user._id })).toBe(1);
  });
});
