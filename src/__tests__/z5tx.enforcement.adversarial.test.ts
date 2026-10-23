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
import jobRoutes from '../routes/jobRoutes';
import { generateToken } from '../utils/generateToken';
import { companyKey, roleKey } from '../utils/companyHistory';
import {
  getActiveRejectionBlocks,
  findBlockForJob,
  buildMatcherSignals,
  applyRejectionEnforcement,
  isRejectionBlockingEnabled,
  ActiveRejectionSignal,
} from '../services/rejectionSignalService';

const app = express();
app.use(express.json());
app.use('/api/matches', matchRoutes);
app.use('/api/jobs', jobRoutes);
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(res.statusCode !== 200 ? res.statusCode : 500).json({ error: err.message })
);

const DAY = 24 * 3600 * 1000;
let seq = 0;

afterEach(() => { delete process.env.REJECTION_BLOCKS_ENABLED; });

describe('R11 companyKey / roleKey', () => {
  it('Duck Duck Go == DuckDuckGo', () => expect(companyKey('Duck Duck Go')).toBe(companyKey('DuckDuckGo')));
  it('Ashby Inc. == Ashby', () => expect(companyKey('Ashby Inc.')).toBe(companyKey('Ashby')));
  it('Ashby Labs != Ashby', () => expect(companyKey('Ashby Labs')).not.toBe(companyKey('Ashby')));
  it('case + diacritics insensitive', () => {
    expect(companyKey('ZOÉ Technologies')).toBe(companyKey('zoe technologies'));
    expect(companyKey('Café')).toBe(companyKey('CAFE'));
  });
  it('distinct companies differ and key non-empty', () => {
    expect(companyKey('Camunda')).not.toBe(companyKey('Tether'));
    expect(companyKey('Camunda').length).toBeGreaterThan(0);
  });
  it('roleKey strips seniority words', () => {
    expect(roleKey('Senior Software Engineer II')).toBe(roleKey('software engineer'));
    expect(roleKey('Sr. Software Engineer')).toBe(roleKey('software engineer'));
    expect(roleKey('Staff Principal Lead Jr Software Engineer IV')).toBe(roleKey('software engineer'));
    expect(roleKey('Junior Software Engineer III')).toBe(roleKey('Software Engineer'));
    expect(roleKey('Software Engineer I')).toBe(roleKey('Software Engineer'));
  });
  it('roleKey lowercase no punctuation', () => {
    const k = roleKey('Senior Data Scientist!');
    expect(k).toBe(roleKey('data scientist'));
    expect(k).toBe(k.toLowerCase());
    expect(k).not.toMatch(/[!.,]/);
  });
  it('roleKey whole-word only: Leadership Coach keeps leadership', () => {
    expect(roleKey('Leadership Coach')).toContain('leadership');
    expect(roleKey('Team Leader')).toContain('leader');
    expect(roleKey('Principal Engineer')).not.toBe(roleKey('Principle Engineer'));
    expect(roleKey('Staffing Coordinator')).toContain('staffing');
    expect(roleKey('Iterative Designer')).toContain('iterative');
  });
  it('different roles differ', () => expect(roleKey('Backend Engineer')).not.toBe(roleKey('Frontend Engineer')));
});

describe('R12 flag', () => {
  it.each([['true', true], ['TRUE', false], ['True', false], ['1', false], ['yes', false], ['', false], [' true', false]])(
    'REJECTION_BLOCKS_ENABLED=%p => %p', (v, exp) => {
      process.env.REJECTION_BLOCKS_ENABLED = v as string;
      expect(isRejectionBlockingEnabled()).toBe(exp);
    });
  it('unset => false', () => { delete process.env.REJECTION_BLOCKS_ENABLED; expect(isRejectionBlockingEnabled()).toBe(false); });
});

async function seed(userId: any, over: any = {}) {
  seq++;
  const company = over.company || 'Camunda';
  const doc: any = await RejectionSignal.create({
    userId, matchId: new mongoose.Types.ObjectId(), jobId: new mongoose.Types.ObjectId(), source: 'skip', category: 'other',
    company, companyKey: companyKey(company), title: 'Software Engineer', roleKey: 'software engineer',
    scope: 'company', duration: 'permanent', blockedUntil: null, status: 'active', analysisStatus: 'ok',
    ...over,
  });
  if (over.createdAt) await RejectionSignal.collection.updateOne({ _id: doc._id }, { $set: { createdAt: over.createdAt } });
  return doc;
}

describe('R12 getActiveRejectionBlocks', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const uid = () => new mongoose.Types.ObjectId();
  const ids = (a: ActiveRejectionSignal[]) => a.map((s) => String(s._id));

  it('active ok permanent company/company_role are returned in companyBlocks', async () => {
    const u = uid();
    const a = await seed(u, { scope: 'company' });
    const b = await seed(u, { scope: 'company_role', company: 'Tether' });
    const r = await getActiveRejectionBlocks(u, now);
    expect(ids(r.companyBlocks).sort()).toEqual([String(a._id), String(b._id)].sort());
    expect(r.contextSignals).toHaveLength(0);
  });

  it('temporary: blockedUntil just future active, equal/just past excluded', async () => {
    const u = uid();
    const fut = await seed(u, { duration: 'temporary', blockedUntil: new Date(now.getTime() + 1000), company: 'A1' });
    await seed(u, { duration: 'temporary', blockedUntil: new Date(now.getTime()), company: 'A2' });
    await seed(u, { duration: 'temporary', blockedUntil: new Date(now.getTime() - 1000), company: 'A3' });
    const r = await getActiveRejectionBlocks(u, now);
    expect(ids(r.companyBlocks)).toEqual([String(fut._id)]);
  });

  it('temporary with null blockedUntil is not a block', async () => {
    const u = uid();
    await seed(u, { duration: 'temporary', blockedUntil: null });
    expect((await getActiveRejectionBlocks(u, now)).companyBlocks).toHaveLength(0);
  });

  it('revoked, failed, skipped, scope none, duration none, other users excluded', async () => {
    const u = uid();
    await seed(u, { status: 'revoked', revokedAt: now });
    await seed(u, { analysisStatus: 'failed' });
    await seed(u, { analysisStatus: 'skipped' });
    await seed(u, { scope: 'none', duration: 'none' });
    await seed(uid(), {});
    const r = await getActiveRejectionBlocks(u, now);
    expect(r.companyBlocks).toHaveLength(0);
    expect(r.contextSignals).toHaveLength(0);
  });

  it('role/attribute go to contextSignals; expired and revoked context excluded', async () => {
    const u = uid();
    const r1 = await seed(u, { scope: 'role', company: 'Z1' });
    const a1 = await seed(u, { scope: 'attribute', attribute: 'avoids Indian companies', company: 'Zinnia' });
    await seed(u, { scope: 'attribute', attribute: 'expired', duration: 'temporary', blockedUntil: new Date(now.getTime() - 1000) });
    await seed(u, { scope: 'role', status: 'revoked', revokedAt: now, company: 'Z2' });
    const r = await getActiveRejectionBlocks(u, now);
    expect(r.companyBlocks).toHaveLength(0);
    expect(ids(r.contextSignals).sort()).toEqual([String(r1._id), String(a1._id)].sort());
  });

  it('contextSignals: newest first, deduped, max 20', async () => {
    const u = uid();
    const base = now.getTime();
    // duplicates of the same attribute (different matches): one entry, newest wins
    const dupOld = await seed(u, { scope: 'attribute', attribute: 'avoids Indian companies', createdAt: new Date(base - 50 * DAY) });
    const dupNew = await seed(u, { scope: 'attribute', attribute: 'avoids Indian companies', createdAt: new Date(base - 1 * DAY) });
    const created: any[] = [];
    for (let i = 0; i < 24; i++) {
      created.push(await seed(u, { scope: 'attribute', attribute: `attr-${i}`, createdAt: new Date(base - (i + 2) * DAY) }));
    }
    const r = await getActiveRejectionBlocks(u, now);
    expect(r.contextSignals).toHaveLength(20);
    const got = ids(r.contextSignals);
    expect(got).not.toContain(String(dupOld._id));
    expect(got[0]).toBe(String(dupNew._id));
    // newest-first ordering for the rest
    expect(got.slice(1)).toEqual(created.slice(0, 19).map((c) => String(c._id)));
  });

  it('returned objects expose the contract fields', async () => {
    const u = uid();
    await seed(u, { scope: 'company', category: 'other', details: 'tedious', company: 'Tether' });
    const [s] = (await getActiveRejectionBlocks(u, now)).companyBlocks;
    expect(s).toMatchObject({ scope: 'company', category: 'other', details: 'tedious', company: 'Tether', companyKey: companyKey('Tether'), duration: 'permanent' });
    expect(s._id).toBeTruthy();
  });

  it('omitting now uses current time', async () => {
    const u = uid();
    const live = await seed(u, { duration: 'temporary', blockedUntil: new Date(Date.now() + 3600_000) });
    await seed(u, { duration: 'temporary', blockedUntil: new Date(Date.now() - 3600_000), company: 'Old' });
    expect(ids((await getActiveRejectionBlocks(u)).companyBlocks)).toEqual([String(live._id)]);
  });
});

function sig(over: Partial<ActiveRejectionSignal> & { company: string; title?: string }): ActiveRejectionSignal {
  return {
    _id: new mongoose.Types.ObjectId(), scope: 'company', category: 'other', title: over.title || 'Software Engineer',
    companyKey: companyKey(over.company), roleKey: roleKey(over.title || 'Software Engineer'), duration: 'permanent', blockedUntil: null,
    ...over,
  } as any;
}
const noBlocks = { companyBlocks: [], contextSignals: [] };

describe('findBlockForJob', () => {
  it('company matches by key regardless of role/variant', () => {
    const b = sig({ company: 'Ashby' });
    expect(findBlockForJob([b], { company: 'Ashby Inc.', title: 'Anything' })).toBe(b);
    expect(findBlockForJob([b], { company: 'Ashby Labs', title: 'Anything' })).toBeUndefined();
  });
  it('company_role needs role too', () => {
    const b = sig({ company: 'Ashby', scope: 'company_role', title: 'Backend Engineer' });
    expect(findBlockForJob([b], { company: 'Ashby', title: 'Senior Backend Engineer II' })).toBe(b);
    expect(findBlockForJob([b], { company: 'Ashby', title: 'Designer' })).toBeUndefined();
    expect(findBlockForJob([], { company: 'Ashby', title: 'x' })).toBeUndefined();
  });
});

describe('buildMatcherSignals', () => {
  it('maps id/scope/attribute/category/details', () => {
    const a = sig({ company: 'Zinnia', scope: 'attribute', attribute: 'avoids Indian companies', category: 'company_type', details: 'I avoid Indian companies' });
    const r = sig({ company: 'X', scope: 'role', title: 'Sales Manager' });
    const out = buildMatcherSignals([a, r]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: String(a._id), scope: 'attribute', attribute: 'avoids Indian companies', category: 'company_type', details: 'I avoid Indian companies' });
    expect(out[1]).toMatchObject({ id: String(r._id), scope: 'role' });
    expect(String(out[1].role).toLowerCase()).toContain('sales manager');
    expect(buildMatcherSignals([])).toEqual([]);
  });
});

describe('R13 applyRejectionEnforcement', () => {
  const job = { company: 'Camunda', title: 'Software Engineer' };
  const run = (matchScore: number, minScore: number, blocks: any, violatedSignalIds?: string[], j = job) => {
    process.env.REJECTION_BLOCKS_ENABLED = 'true';
    return applyRejectionEnforcement({ matchScore, minScore, job: j, blocks, violatedSignalIds });
  };

  it.each([[85, 30, 29], [31, 30, 29], [30, 30, 29], [29, 30, 29], [10, 30, 10], [100, 1, 0]])(
    'company block: score %p min %p => %p with a note', (s, m, exp) => {
      const r = run(s, m, { companyBlocks: [sig({ company: 'Camunda' })], contextSignals: [] });
      expect(r.matchScore).toBe(exp);
      expect(typeof r.note).toBe('string');
      expect(r.note!.trim().length).toBeGreaterThan(0);
    });

  it('minScore 0 never yields a negative score (MatchRecord.matchScore min 0)', () => {
    const r = run(50, 0, { companyBlocks: [sig({ company: 'Camunda' })], contextSignals: [] });
    expect(r.matchScore).toBeGreaterThanOrEqual(0);
  });

  it('no blocks => unchanged, note null', () => {
    expect(run(85, 30, noBlocks)).toEqual({ matchScore: 85, note: null });
  });
  it('different company not blocked; Ashby Labs vs Ashby', () => {
    const blocks = { companyBlocks: [sig({ company: 'Ashby' })], contextSignals: [] };
    expect(run(85, 30, blocks, [], { company: 'Tether', title: 'Software Engineer' })).toEqual({ matchScore: 85, note: null });
    expect(run(85, 30, blocks, [], { company: 'Ashby Labs', title: 'Software Engineer' })).toEqual({ matchScore: 85, note: null });
  });
  it('same company key variant is blocked', () => {
    const blocks = { companyBlocks: [sig({ company: 'Ashby' })], contextSignals: [] };
    expect(run(85, 30, blocks, [], { company: 'Ashby Inc.', title: 'Designer' }).matchScore).toBe(29);
  });
  it('company_role: same role (seniority-insensitive) blocked, other role not', () => {
    const blocks = { companyBlocks: [sig({ company: 'Camunda', scope: 'company_role', title: 'Backend Engineer' })], contextSignals: [] };
    expect(run(85, 30, blocks, [], { company: 'Camunda', title: 'Senior Backend Engineer II' }).matchScore).toBe(29);
    expect(run(85, 30, blocks, [], { company: 'Camunda', title: 'Product Designer' })).toEqual({ matchScore: 85, note: null });
    expect(run(85, 30, blocks, [], { company: 'Tether', title: 'Backend Engineer' })).toEqual({ matchScore: 85, note: null });
  });
  it('violated context signal id caps; unknown ids ignored; empty/undefined ignored', () => {
    const ctx = sig({ company: 'Zinnia', scope: 'attribute', attribute: 'avoids Indian companies' });
    const blocks = { companyBlocks: [], contextSignals: [ctx] };
    const hit = run(85, 30, blocks, [String(ctx._id)]);
    expect(hit.matchScore).toBe(29);
    expect(hit.note && hit.note.length).toBeGreaterThan(0);
    expect(run(85, 30, blocks, [String(new mongoose.Types.ObjectId())])).toEqual({ matchScore: 85, note: null });
    expect(run(85, 30, blocks, ['bogus'])).toEqual({ matchScore: 85, note: null });
    expect(run(85, 30, blocks, [])).toEqual({ matchScore: 85, note: null });
    expect(run(85, 30, blocks, undefined)).toEqual({ matchScore: 85, note: null });
    expect(run(85, 30, blocks, ['bogus', String(ctx._id)]).matchScore).toBe(29);
  });
  it('never raises a low score via violated id', () => {
    const ctx = sig({ company: 'Z', scope: 'role' });
    expect(run(5, 30, { companyBlocks: [], contextSignals: [ctx] }, [String(ctx._id)]).matchScore).toBe(5);
  });
});

// ---------- on-demand HTTP
async function mkUser(extra: any = {}) {
  seq++;
  const u = await User.create({
    name: `U${seq}`, email: `e${seq}-${Date.now()}@t.com`, password: 'pw123456', isVerified: true, walletBalance: 5,
    resume: {
      skills: ['TypeScript', 'Node.js', 'MongoDB'],
      experience: ['Senior Software Engineer at Foo (2018-2024): built APIs in Node.js and TypeScript'],
      education: ['BS Computer Science'],
      summary: 'Backend engineer with 8 years of experience building scalable services.',
      certifications: [], languages: ['English'], projects: [], achievements: [], volunteerExperience: [], interests: [],
    },
    ...extra,
  });
  return { user: u, token: generateToken(u._id.toString()) };
}
async function mkJob(company: string, title = 'Software Engineer') {
  seq++;
  return JobListing.create({
    title, company, location: ['Remote'], source: 'test', description: 'Build backend services in Node.js and TypeScript.',
    url: `https://x.com/${seq}-${Math.random()}`, postedDate: new Date(Date.now() - 2 * DAY), scrapedDate: new Date(),
  });
}
let matcherReply: (sent: any) => any;
beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockImplementation(async (arg: any) => {
    const body = matcherReply ? matcherReply(arg) : { matchScore: 85, verdict: 'Strong match', reasoning: 'Great fit.' };
    return { choices: [{ message: { content: JSON.stringify(body) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } };
  });
  matcherReply = () => ({ matchScore: 85, verdict: 'Strong match', reasoning: 'Great fit.' });
});
const match = (t: string, jobId: any) => request(app).post(`/api/jobs/${jobId}/match`).set({ Authorization: `Bearer ${t}` }).send({});

describe('R14 on-demand match enforcement', () => {
  it('flag off control: blocked company NOT capped, wallet debited', async () => {
    const { user, token } = await mkUser();
    await seed(user._id, { company: 'Camunda' });
    const job = await mkJob('Camunda');
    const res = await match(token, job._id);
    expect(res.status).toBeLessThan(300);
    const m = await MatchRecord.findOne({ userId: user._id, jobId: job._id });
    expect(m).toBeTruthy();
    expect(m!.matchScore).toBe(85);
    expect((await User.findById(user._id))!.walletBalance).toBeLessThan(5);
  });

  it('flag on: blocked company still scored (2xx), capped below default minScore 30, reasoning mentions company, wallet debited same as control', async () => {
    const ctl = await mkUser();
    const cj = await mkJob('Tether');
    expect((await match(ctl.token, cj._id)).status).toBeLessThan(300);
    const ctlDebit = 5 - (await User.findById(ctl.user._id))!.walletBalance;
    expect(ctlDebit).toBeGreaterThan(0);

    process.env.REJECTION_BLOCKS_ENABLED = 'true';
    const { user, token } = await mkUser();
    await seed(user._id, { company: 'Camunda', details: "applied too many times, can't apply again for 30 days" });
    const job = await mkJob('Camunda');
    const res = await match(token, job._id);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const m = await MatchRecord.findOne({ userId: user._id, jobId: job._id });
    expect(m).toBeTruthy();
    expect(m!.matchScore).toBeLessThan(30);
    expect(m!.reasoning.toLowerCase()).toContain('camunda');
    const debit = 5 - (await User.findById(user._id))!.walletBalance;
    expect(debit).toBeCloseTo(ctlDebit, 6);
    expect(mockCreate).toHaveBeenCalledTimes(2); // scored (not refused) for both
  });

  it('respects user minScore (cap < minScore 60)', async () => {
    process.env.REJECTION_BLOCKS_ENABLED = 'true';
    const { user, token } = await mkUser({ preferences: { minScore: 60 } });
    await seed(user._id, { company: 'Camunda' });
    const job = await mkJob('Camunda');
    await match(token, job._id);
    const m = await MatchRecord.findOne({ userId: user._id, jobId: job._id });
    expect(m!.matchScore).toBeLessThan(60);
  });

  it.each(['TRUE', '1', ''])('flag %p is off => no cap', async (v) => {
    process.env.REJECTION_BLOCKS_ENABLED = v;
    const { user, token } = await mkUser();
    await seed(user._id, { company: 'Camunda' });
    const job = await mkJob('Camunda');
    await match(token, job._id);
    expect((await MatchRecord.findOne({ userId: user._id, jobId: job._id }))!.matchScore).toBe(85);
  });

  it('flag on: unrelated company, expired block, revoked block, other user block => not capped', async () => {
    process.env.REJECTION_BLOCKS_ENABLED = 'true';
    const { user, token } = await mkUser();
    const other = await mkUser();
    await seed(user._id, { company: 'Tether', scope: 'company' });
    await seed(user._id, { company: 'Expired Co', duration: 'temporary', blockedUntil: new Date(Date.now() - 1000) });
    await seed(user._id, { company: 'Revoked Co', status: 'revoked', revokedAt: new Date() });
    await seed(other.user._id, { company: 'Other Co' });
    for (const c of ['Expired Co', 'Revoked Co', 'Other Co', 'Fresh Co']) {
      const job = await mkJob(c);
      // reset rate limit between calls, if any
      await User.updateOne({ _id: user._id }, { $unset: { lastManualMatchAt: 1 } });
      const res = await match(token, job._id);
      expect(res.status).toBeLessThan(300);
      expect((await MatchRecord.findOne({ userId: user._id, jobId: job._id }))!.matchScore).toBe(85);
    }
  });

  it('company_role block does not cap a different role at the company', async () => {
    process.env.REJECTION_BLOCKS_ENABLED = 'true';
    const { user, token } = await mkUser();
    await seed(user._id, { company: 'Camunda', scope: 'company_role', title: 'Backend Engineer', roleKey: roleKey('Backend Engineer') });
    const designer = await mkJob('Camunda', 'Product Designer');
    await match(token, designer._id);
    expect((await MatchRecord.findOne({ userId: user._id, jobId: designer._id }))!.matchScore).toBe(85);
    await User.updateOne({ _id: user._id }, { $unset: { lastManualMatchAt: 1 } });
    const be = await mkJob('Camunda', 'Senior Backend Engineer II');
    await match(token, be._id);
    expect((await MatchRecord.findOne({ userId: user._id, jobId: be._id }))!.matchScore).toBeLessThan(30);
  });

  it('matcher violatedSignalIds (sent ids only) caps; unsent ids are ignored; ids are actually sent to the model', async () => {
    process.env.REJECTION_BLOCKS_ENABLED = 'true';
    const { user, token } = await mkUser();
    const ctx = await seed(user._id, { company: 'Zinnia', scope: 'attribute', attribute: 'avoids Indian companies', details: 'I avoid Indian companies' });
    const job = await mkJob('Indiacorp');
    matcherReply = () => ({ matchScore: 85, verdict: 'Strong', reasoning: 'ok', violatedSignalIds: [String(ctx._id)] });
    expect((await match(token, job._id)).status).toBeLessThan(300);
    expect(JSON.stringify(mockCreate.mock.calls[0][0])).toContain(String(ctx._id));
    expect((await MatchRecord.findOne({ userId: user._id, jobId: job._id }))!.matchScore).toBeLessThan(30);

    // bogus id never sent => no cap
    await User.updateOne({ _id: user._id }, { $unset: { lastManualMatchAt: 1 } });
    const job2 = await mkJob('Indiacorp2');
    matcherReply = () => ({ matchScore: 85, verdict: 'Strong', reasoning: 'ok', violatedSignalIds: [String(new mongoose.Types.ObjectId())] });
    await match(token, job2._id);
    expect((await MatchRecord.findOne({ userId: user._id, jobId: job2._id }))!.matchScore).toBe(85);
  });

  it('violatedSignalIds with flag off: signals not sent, no cap', async () => {
    const { user, token } = await mkUser();
    const ctx = await seed(user._id, { company: 'Zinnia', scope: 'attribute', attribute: 'avoids Indian companies' });
    const job = await mkJob('Indiacorp');
    matcherReply = () => ({ matchScore: 85, verdict: 'Strong', reasoning: 'ok', violatedSignalIds: [String(ctx._id)] });
    await match(token, job._id);
    expect(JSON.stringify(mockCreate.mock.calls[0][0])).not.toContain(String(ctx._id));
    expect((await MatchRecord.findOne({ userId: user._id, jobId: job._id }))!.matchScore).toBe(85);
  });
});

describe('R15 out-of-credit preview', () => {
  const preview = (t: string) => request(app).get('/api/matches/out-of-credit-preview').set({ Authorization: `Bearer ${t}` });
  const numbers = (o: any): string => JSON.stringify(o);

  it('flag on excludes jobs from blocked companies; flag off includes them', async () => {
    const { user, token } = await mkUser({ walletBalance: 0 });
    for (let i = 0; i < 3; i++) await mkJob('Camunda', `Backend Engineer ${i}`);
    for (let i = 0; i < 3; i++) await mkJob('Tether', `Platform Engineer ${i}`);
    await seed(user._id, { company: 'Camunda' });

    const off = await preview(token);
    expect(off.status).toBe(200);
    process.env.REJECTION_BLOCKS_ENABLED = 'true';
    const on = await preview(token);
    expect(on.status).toBe(200);

    // The blocked company's jobs must not show up when the flag is on.
    expect(numbers(on.body)).not.toMatch(/Camunda/);
    // Control: with flag off, the preview does cover Camunda (otherwise the test proves nothing).
    expect(numbers(off.body)).toMatch(/Camunda/);
    expect(numbers(on.body)).toMatch(/Tether/);
    expect(numbers(on.body)).not.toBe(numbers(off.body));
  });
});
