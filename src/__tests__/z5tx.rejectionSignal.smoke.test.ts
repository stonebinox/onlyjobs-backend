process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('openai', () => {
  const mockCreate = jest.fn();
  const MockConstructor = jest.fn().mockReturnValue({
    chat: { completions: { create: mockCreate } },
  });
  (MockConstructor as any).__mockCreate = mockCreate;
  return { __esModule: true, default: MockConstructor };
});

import OpenAI from 'openai';
import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import MatchRecord, { Freshness } from '../models/MatchRecord';
import JobListing from '../models/JobListing';
import User from '../models/User';
import RejectionSignal from '../models/RejectionSignal';
import { generateToken } from '../utils/generateToken';
import { companyKey, roleKey } from '../utils/companyHistory';
import matchRoutes from '../routes/matchRoutes';
import jobRoutes from '../routes/jobRoutes';
import * as signalService from '../services/rejectionSignalService';
import { revokeSignalsForMatch } from '../services/rejectionSignalService';

const mockCreate = (OpenAI as any).__mockCreate as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/matches', matchRoutes);
app.use('/api/jobs', jobRoutes);
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(res.statusCode !== 200 ? res.statusCode : 500).json({ error: err.message });
});

function modelReply(signal: object | undefined) {
  return {
    choices: [
      { message: { content: JSON.stringify({ updatedInsights: 'Dislikes slow processes.', signal }) } },
    ],
  };
}

async function setup() {
  const userId = new mongoose.Types.ObjectId();
  await User.create({
    _id: userId,
    name: 'Signal Test',
    email: `z5tx-${userId.toString()}@example.com`,
    password: 'hashed',
    isVerified: true,
  });
  const job = await JobListing.create({
    title: 'Senior Backend Engineer',
    company: 'Camunda',
    location: ['Remote'],
    source: 'test',
    description: 'A test job',
    url: `https://example.com/${userId.toString()}`,
    postedDate: new Date(),
  });
  const match = await MatchRecord.create({
    userId,
    jobId: job._id,
    matchScore: 80,
    verdict: 'Strong match',
    reasoning: 'r',
    freshness: Freshness.FRESH,
    clicked: false,
    skipped: false,
    applied: null,
  });
  return {
    userId,
    token: generateToken(userId.toString()),
    job,
    match: { _id: match._id as mongoose.Types.ObjectId },
  };
}

beforeEach(() => mockCreate.mockReset());

describe('companyKey / roleKey', () => {
  it('merges spacing and legal-suffix variants but keeps distinct companies apart', () => {
    expect(companyKey('Duck Duck Go')).toBe(companyKey('DuckDuckGo'));
    expect(companyKey('Ashby Inc.')).toBe(companyKey('Ashby'));
    expect(companyKey('Ashby Labs')).not.toBe(companyKey('Ashby'));
  });

  it('strips seniority words and punctuation from role titles', () => {
    expect(roleKey('Senior Backend Engineer')).toBe('backend engineer');
    expect(roleKey('Sr. Backend Engineer II')).toBe('backend engineer');
    expect(roleKey('Staff Backend-Engineer')).toBe('backend engineer');
  });

  it('keeps multi-word roles aligned across seniority and apart across different roles', () => {
    expect(roleKey('Senior Backend Engineer')).toBe(roleKey('backend engineer'));
    expect(roleKey('Staff Backend Engineer')).not.toBe(roleKey('Backend Engineering Manager'));
  });
});

describe('rejection signals over HTTP', () => {
  it('skip with reason persists one signal and returns it', async () => {
    const { token, match } = await setup();
    mockCreate.mockResolvedValue(
      modelReply({ scope: 'company', duration: 'temporary', cooldownDays: 30, rationale: 'cap' })
    );

    const res = await request(app)
      .post('/api/matches/skip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), reason: 'other', details: 'can only apply once a month' });

    expect(res.status).toBe(200);
    expect(res.body.signal).toMatchObject({ scope: 'company', company: 'Camunda', duration: 'temporary' });
    expect(res.body.signal.blockedUntil).toBeTruthy();
    const rows = await RejectionSignal.find({ matchId: match._id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'skip', companyKey: 'camunda', roleKey: 'backend engineer', status: 'active' });
  });

  it('sidebar No (applied=false) persists a not_applied signal', async () => {
    const { token, match } = await setup();
    mockCreate.mockResolvedValue(modelReply({ scope: 'attribute', attribute: 'company HQ in India', duration: 'permanent' }));

    const res = await request(app)
      .post('/api/matches/applied')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), applied: false, reason: 'other', details: 'never Indian companies' });

    expect(res.status).toBe(200);
    expect(res.body.signal).toMatchObject({ scope: 'attribute', duration: 'permanent', blockedUntil: null });
    const rows = await RejectionSignal.find({ matchId: match._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('not_applied');
  });

  it('a model reply with no signal still succeeds and records a failed analysis', async () => {
    const { token, match } = await setup();
    mockCreate.mockResolvedValue(modelReply(undefined));

    const res = await request(app)
      .post('/api/matches/skip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), reason: 'other', details: 'meh' });

    expect(res.status).toBe(200);
    expect(res.body.signal).toBeNull();
    const row = await RejectionSignal.findOne({ matchId: match._id });
    expect(row).toMatchObject({ analysisStatus: 'failed', scope: 'none', duration: 'none' });
  });

  it('unskip revokes the signal', async () => {
    const { token, match } = await setup();
    mockCreate.mockResolvedValue(modelReply({ scope: 'company', duration: 'permanent' }));
    await request(app)
      .post('/api/matches/skip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), reason: 'other', details: 'no' });

    const res = await request(app)
      .post('/api/matches/unskip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Match unskipped' });
    const row = await RejectionSignal.findOne({ matchId: match._id });
    expect(row!.status).toBe('revoked');
    expect(row!.revokedAt).toBeTruthy();
  });

  it('revoke-block revokes the signal but keeps the skip', async () => {
    const { token, match } = await setup();
    mockCreate.mockResolvedValue(modelReply({ scope: 'company', duration: 'permanent' }));
    await request(app)
      .post('/api/matches/skip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), reason: 'other', details: 'no' });

    const res = await request(app)
      .post('/api/matches/revoke-block')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString() });

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(1);
    expect((await RejectionSignal.findOne({ matchId: match._id }))!.status).toBe('revoked');
    expect((await MatchRecord.findById(match._id))!.skipped).toBe(true);
  });

  it('revoke-block rejects another user\'s match', async () => {
    const { match } = await setup();
    const other = await setup();

    const res = await request(app)
      .post('/api/matches/revoke-block')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ matchId: match._id.toString() });

    expect(res.status).toBe(403);
  });
});

const seedBlock = (userId: mongoose.Types.ObjectId, job: { _id: any; title: string; company: string }) =>
  RejectionSignal.create({
    userId, matchId: new mongoose.Types.ObjectId(), jobId: job._id, source: 'skip', category: 'other',
    company: job.company, companyKey: companyKey(job.company), title: job.title, roleKey: roleKey(job.title),
    scope: 'company', duration: 'permanent', blockedUntil: null, status: 'active', analysisStatus: 'ok', analysisVersion: 1,
  });

const seedSibling = (userId: mongoose.Types.ObjectId, company = 'Camunda') =>
  RejectionSignal.create({
    userId, matchId: new mongoose.Types.ObjectId(), jobId: new mongoose.Types.ObjectId(), source: 'skip',
    category: 'other', company, companyKey: companyKey(company), title: 'Designer', roleKey: 'designer',
    scope: 'company', duration: 'permanent', blockedUntil: null, status: 'active', analysisStatus: 'ok', analysisVersion: 1,
  });

type UndoCase = {
  name: string;
  route: string;
  body: (matchId: string) => Record<string, unknown>;
  undoRoute: string;
  undoBody: (matchId: string) => Record<string, unknown>;
  undoState: Record<string, unknown>;
};

const UNDO_CASES: UndoCase[] = [
  {
    name: 'skip',
    route: '/api/matches/skip',
    body: (matchId) => ({ matchId, reason: 'other', details: 'no' }),
    undoRoute: '/api/matches/unskip',
    undoBody: (matchId) => ({ matchId }),
    undoState: { $set: { skipped: false }, $unset: { skipReason: 1 } },
  },
  {
    name: 'not_applied',
    route: '/api/matches/applied',
    body: (matchId) => ({ matchId, applied: false, reason: 'other', details: 'no' }),
    undoRoute: '/api/matches/applied',
    undoBody: (matchId) => ({ matchId, applied: true }),
    undoState: { $set: { applied: true } },
  },
];

describe.each(UNDO_CASES)('undo race ($name)', (c) => {
  afterEach(() => jest.restoreAllMocks());

  it('undo while the LLM call is deferred leaves no active signal and sweeps the sibling company block', async () => {
    const { userId, token, match } = await setup();
    const sibling = await seedSibling(userId);
    let release!: (v: unknown) => void;
    mockCreate.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const pending = request(app)
      .post(c.route)
      .set('Authorization', `Bearer ${token}`)
      .send(c.body(match._id.toString()))
      .then((r) => r);
    while (mockCreate.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 10));

    await request(app)
      .post(c.undoRoute)
      .set('Authorization', `Bearer ${token}`)
      .send(c.undoBody(match._id.toString()));
    release(modelReply({ scope: 'company', duration: 'permanent' }));
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body.signal).toBeNull();
    expect(await RejectionSignal.countDocuments({ userId, status: 'active' })).toBe(0);
    expect((await RejectionSignal.findById(sibling._id))!.status).toBe('revoked');
  });

  it('undo between the signal write and the re-read leaves no active signal and sweeps the sibling company block', async () => {
    const { userId, token, match } = await setup();
    const sibling = await seedSibling(userId);
    mockCreate.mockResolvedValue(modelReply({ scope: 'company', duration: 'permanent' }));
    const original = signalService.persistRejectionSignal;
    jest.spyOn(signalService, 'persistRejectionSignal').mockImplementation(async (params) => {
      const row = await original(params);
      await MatchRecord.updateOne({ _id: match._id }, c.undoState);
      return row;
    });

    const res = await request(app)
      .post(c.route)
      .set('Authorization', `Bearer ${token}`)
      .send(c.body(match._id.toString()));

    expect(res.status).toBe(200);
    expect(res.body.signal).toBeNull();
    expect(await RejectionSignal.countDocuments({ userId, status: 'active' })).toBe(0);
    expect((await RejectionSignal.findById(sibling._id))!.status).toBe('revoked');
  });

  it('an undo leaves a different company\'s active block untouched', async () => {
    const { userId, token, match } = await setup();
    const otherCompany = await seedSibling(userId, 'Globex');
    mockCreate.mockResolvedValue(modelReply({ scope: 'company', duration: 'permanent' }));
    const original = signalService.persistRejectionSignal;
    jest.spyOn(signalService, 'persistRejectionSignal').mockImplementation(async (params) => {
      const row = await original(params);
      await MatchRecord.updateOne({ _id: match._id }, c.undoState);
      return row;
    });

    const res = await request(app)
      .post(c.route)
      .set('Authorization', `Bearer ${token}`)
      .send(c.body(match._id.toString()));

    expect(res.status).toBe(200);
    expect(res.body.signal).toBeNull();
    expect((await RejectionSignal.findById(otherCompany._id))!.status).toBe('active');
    expect(await RejectionSignal.countDocuments({ userId, status: 'active' })).toBe(1);
  });
});

describe('deleted job listing', () => {
  const cases = [
    { name: 'skip', route: '/api/matches/skip', source: 'skip', body: (matchId: string) => ({ matchId, reason: 'other', details: 'no' }) },
    { name: 'applied=false', route: '/api/matches/applied', source: 'not_applied', body: (matchId: string) => ({ matchId, applied: false, reason: 'other', details: 'no' }) },
  ];

  it.each(cases)('$name still records one skipped-analysis signal and creates no block', async (c) => {
    const { userId, token, job, match } = await setup();
    await JobListing.deleteOne({ _id: job._id });

    const res = await request(app)
      .post(c.route)
      .set('Authorization', `Bearer ${token}`)
      .send(c.body(match._id.toString()));

    expect(res.status).toBe(200);
    expect(res.body.signal).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
    const rows = await RejectionSignal.find({ matchId: match._id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId, jobId: job._id, source: c.source, category: 'other', details: 'no',
      company: '', companyKey: '', title: '', roleKey: '',
      scope: 'none', duration: 'none', analysisStatus: 'skipped', status: 'active',
    });
    expect(await RejectionSignal.countDocuments({ userId, scope: { $in: ['company', 'company_role'] } })).toBe(0);
  });

  it('a repeated skip does not create a second row', async () => {
    const { token, job, match } = await setup();
    await JobListing.deleteOne({ _id: job._id });

    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post('/api/matches/skip')
        .set('Authorization', `Bearer ${token}`)
        .send({ matchId: match._id.toString(), reason: 'other', details: 'no' });
      expect(res.status).toBe(200);
    }

    expect(await RejectionSignal.countDocuments({ matchId: match._id })).toBe(1);
  });

  it.each([
    { name: 'skip', route: '/api/matches/skip', undoRoute: '/api/matches/unskip', source: 'skip',
      body: (matchId: string) => ({ matchId, reason: 'other', details: 'no' }), undoBody: (matchId: string) => ({ matchId }) },
    { name: 'applied=false', route: '/api/matches/applied', undoRoute: '/api/matches/applied', source: 'not_applied',
      body: (matchId: string) => ({ matchId, applied: false, reason: 'other', details: 'no' }),
      undoBody: (matchId: string) => ({ matchId, applied: true }) },
  ])('$name -> undo -> re-do reactivates the single row', async (c) => {
    const { token, job, match } = await setup();
    await JobListing.deleteOne({ _id: job._id });
    const send = (route: string, body: object) =>
      request(app).post(route).set('Authorization', `Bearer ${token}`).send(body);

    expect((await send(c.route, c.body(match._id.toString()))).status).toBe(200);
    expect((await send(c.undoRoute, c.undoBody(match._id.toString()))).status).toBe(200);
    expect((await RejectionSignal.findOne({ matchId: match._id, source: c.source }))!.status).toBe('revoked');

    expect((await send(c.route, c.body(match._id.toString()))).status).toBe(200);

    const rows = await RejectionSignal.find({ matchId: match._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].revokedAt ?? null).toBeNull();
  });
});

describe('revocation failure is not reported as success', () => {
  afterEach(() => jest.restoreAllMocks());

  const failNextRevoke = () =>
    jest.spyOn(RejectionSignal, 'updateMany').mockRejectedValueOnce(new Error('db down') as never);

  it('unskip returns 500 when revoking fails, and a retry succeeds', async () => {
    const { token, match } = await setup();
    mockCreate.mockResolvedValue(modelReply({ scope: 'company', duration: 'permanent' }));
    await request(app)
      .post('/api/matches/skip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), reason: 'other', details: 'no' });
    failNextRevoke();

    const failed = await request(app)
      .post('/api/matches/unskip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString() });

    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe("Couldn't update your hidden companies. Please try again.");
    expect(await RejectionSignal.countDocuments({ matchId: match._id, status: 'active' })).toBe(1);

    const retry = await request(app)
      .post('/api/matches/unskip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString() });

    expect(retry.status).toBe(200);
    expect(await RejectionSignal.countDocuments({ matchId: match._id, status: 'active' })).toBe(0);
  });

  it('applied->true returns 500 when revoking fails, and a retry succeeds', async () => {
    const { token, match } = await setup();
    mockCreate.mockResolvedValue(modelReply({ scope: 'company', duration: 'permanent' }));
    await request(app)
      .post('/api/matches/applied')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), applied: false, reason: 'other', details: 'no' });
    expect(await RejectionSignal.countDocuments({ matchId: match._id, status: 'active' })).toBe(1);
    failNextRevoke();

    const failed = await request(app)
      .post('/api/matches/applied')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), applied: true });

    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe("Couldn't update your hidden companies. Please try again.");
    expect(await RejectionSignal.countDocuments({ matchId: match._id, status: 'active' })).toBe(1);

    const retry = await request(app)
      .post('/api/matches/applied')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), applied: true });

    expect(retry.status).toBe(200);
    expect(await RejectionSignal.countDocuments({ matchId: match._id, status: 'active' })).toBe(0);
  });

  it('revoke-block returns 500 when revoking fails', async () => {
    const { token, match } = await setup();
    mockCreate.mockResolvedValue(modelReply({ scope: 'company', duration: 'permanent' }));
    await request(app)
      .post('/api/matches/skip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString(), reason: 'other', details: 'no' });
    failNextRevoke();

    const res = await request(app)
      .post('/api/matches/revoke-block')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId: match._id.toString() });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Couldn't update your hidden companies. Please try again.");
  });
});

describe('revokeSignalsForMatch scope', () => {
  const seedSignal = async (userId: mongoose.Types.ObjectId, matchId: mongoose.Types.ObjectId, scope: string, source = 'skip') =>
    RejectionSignal.create({
      userId, matchId, jobId: new mongoose.Types.ObjectId(), source, category: 'other', company: 'Camunda',
      companyKey: 'camunda', title: 'Engineer', roleKey: 'engineer', scope,
      attribute: scope === 'attribute' ? 'remote only' : undefined,
      duration: 'permanent', blockedUntil: null, status: 'active', analysisStatus: 'ok', analysisVersion: 1,
    });

  it('a company-scope signal also revokes other company signals for that company', async () => {
    const a = await setup();
    const other = new mongoose.Types.ObjectId();
    await seedSignal(a.userId, a.match._id, 'company');
    await seedSignal(a.userId, other, 'company_role');

    expect(await revokeSignalsForMatch(a.userId, a.match._id)).toBe(2);
    expect(await RejectionSignal.countDocuments({ userId: a.userId, status: 'active' })).toBe(0);
  });

  it('an attribute-scope undo also revokes company blocks for the same company', async () => {
    const a = await setup();
    const other = new mongoose.Types.ObjectId();
    await seedSignal(a.userId, a.match._id, 'attribute');
    const companyBlock = await seedSignal(a.userId, other, 'company');

    expect(await revokeSignalsForMatch(a.userId, a.match._id)).toBe(2);
    expect((await RejectionSignal.findById(companyBlock._id))!.status).toBe('revoked');
  });

  it('a role-scope undo revokes a company block from another match but not another company', async () => {
    const a = await setup();
    await seedSignal(a.userId, a.match._id, 'role');
    const sameCompany = await seedSignal(a.userId, new mongoose.Types.ObjectId(), 'company');
    const otherCompany = await RejectionSignal.create({
      userId: a.userId, matchId: new mongoose.Types.ObjectId(), jobId: new mongoose.Types.ObjectId(), source: 'skip',
      category: 'other', company: 'Globex', companyKey: 'globex', title: 'Engineer', roleKey: 'engineer',
      scope: 'company', duration: 'permanent', blockedUntil: null, status: 'active', analysisStatus: 'ok', analysisVersion: 1,
    });

    expect(await revokeSignalsForMatch(a.userId, a.match._id)).toBe(2);
    expect((await RejectionSignal.findById(sameCompany._id))!.status).toBe('revoked');
    expect((await RejectionSignal.findById(otherCompany._id))!.status).toBe('active');
  });

  it('a match with no active signal of its own revokes nothing', async () => {
    const a = await setup();
    const companyBlock = await seedSignal(a.userId, new mongoose.Types.ObjectId(), 'company');

    expect(await revokeSignalsForMatch(a.userId, a.match._id)).toBe(0);
    expect((await RejectionSignal.findById(companyBlock._id))!.status).toBe('active');
  });
});

describe('parseSignalDecision', () => {
  it.each(['permanent', 'temporary'])("scope none with duration %s is a failed analysis", (duration) => {
    expect(signalService.parseSignalDecision({ scope: 'none', duration })).toMatchObject({ analysisStatus: 'failed' });
  });

  it('scope none with duration none is ok', () => {
    expect(signalService.parseSignalDecision({ scope: 'none', duration: 'none' })).toMatchObject({
      scope: 'none', duration: 'none', analysisStatus: 'ok',
    });
  });
});

describe('on-demand enforcement verdict', () => {
  afterEach(() => { delete process.env.REJECTION_BLOCKS_ENABLED; });

  it('a capped score never persists a Strong match verdict', async () => {
    process.env.REJECTION_BLOCKS_ENABLED = 'true';
    const { userId, token, job } = await setup();
    await User.updateOne({ _id: userId }, { $set: { walletBalance: 5, resume: {
      skills: ['TypeScript'], experience: ['Engineer at Foo: built APIs'], education: ['BS CS'],
      summary: 'Backend engineer.', certifications: [], languages: ['English'], projects: [],
      achievements: [], volunteerExperience: [], interests: [],
    } } });
    await MatchRecord.deleteMany({ userId });
    await seedBlock(userId, job);
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ matchScore: 90, verdict: 'Strong match', reasoning: 'Great fit.' }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const res = await request(app).post(`/api/jobs/${job._id}/match`).set('Authorization', `Bearer ${token}`).send({});

    expect(res.status).toBeLessThan(300);
    const m = await MatchRecord.findOne({ userId, jobId: job._id });
    expect(m!.matchScore).toBeLessThan(30);
    expect(m!.verdict).toBe('Weak match');
  });
});

describe('repeat-rejection override prior-row filter', () => {
  const seedPrior = (
    userId: mongoose.Types.ObjectId,
    job: { _id: any; title: string; company: string },
    fields: Record<string, unknown>
  ) =>
    RejectionSignal.create({
      userId, matchId: new mongoose.Types.ObjectId(), jobId: job._id, source: 'skip', category: 'other',
      company: job.company, companyKey: companyKey(job.company), title: job.title, roleKey: roleKey(job.title),
      status: 'active', analysisVersion: 1, ...fields,
    });

  const skipWithNoScope = async (token: string, matchId: string) => {
    mockCreate.mockResolvedValue(modelReply({ scope: 'none', duration: 'none' }));
    const res = await request(app)
      .post('/api/matches/skip')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchId, reason: 'other', details: 'meh' });
    expect(res.status).toBe(200);
    return RejectionSignal.findOne({ matchId });
  };

  it('two prior ok+scope-none rows do not trigger the override', async () => {
    const { userId, token, job, match } = await setup();
    for (let i = 0; i < 2; i++) {
      await seedPrior(userId, job, { scope: 'none', duration: 'none', analysisStatus: 'ok' });
    }
    expect(await skipWithNoScope(token, match._id.toString())).toMatchObject({ scope: 'none', duration: 'none' });
  });

  it('two prior failed-analysis rows trigger the override', async () => {
    const { userId, token, job, match } = await setup();
    for (let i = 0; i < 2; i++) {
      await seedPrior(userId, job, { scope: 'none', duration: 'none', analysisStatus: 'failed' });
    }
    expect(await skipWithNoScope(token, match._id.toString())).toMatchObject({ scope: 'company', duration: 'temporary' });
  });

  it('two prior expired temporary company rows trigger the override', async () => {
    const { userId, token, job, match } = await setup();
    for (let i = 0; i < 2; i++) {
      await seedPrior(userId, job, {
        scope: 'company', duration: 'temporary', cooldownDays: 30, analysisStatus: 'ok',
        blockedUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
    }
    expect(await skipWithNoScope(token, match._id.toString())).toMatchObject({ scope: 'company', duration: 'temporary' });
  });
});

describe('deleted listing undo race', () => {
  it.each([
    { name: 'skip', route: '/api/matches/skip', body: (matchId: string) => ({ matchId, reason: 'other', details: 'no' }), undo: { $set: { skipped: false } } },
    { name: 'applied=false', route: '/api/matches/applied', body: (matchId: string) => ({ matchId, applied: false, reason: 'other', details: 'no' }), undo: { $set: { applied: true } } },
  ])('$name undone before the audit row is written ends revoked', async (c) => {
    const { userId, token, job, match } = await setup();
    await JobListing.deleteOne({ _id: job._id });
    const originalCreate = RejectionSignal.create.bind(RejectionSignal) as (...a: any[]) => Promise<any>;
    const spy = jest.spyOn(RejectionSignal, 'create').mockImplementation((async (...args: any[]) => {
      await MatchRecord.updateOne({ _id: match._id }, c.undo);
      return originalCreate(...args);
    }) as any);

    const res = await request(app)
      .post(c.route)
      .set('Authorization', `Bearer ${token}`)
      .send(c.body(match._id.toString()));
    spy.mockRestore();

    expect(res.status).toBe(200);
    const rows = await RejectionSignal.find({ matchId: match._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('revoked');
    expect(await RejectionSignal.countDocuments({ userId, status: 'active' })).toBe(0);
  });
});
