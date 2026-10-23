jest.mock('openai', () => {
  const mockCreate = jest.fn();
  const MockConstructor = jest.fn().mockReturnValue({
    chat: { completions: { create: mockCreate } },
  });
  (MockConstructor as unknown as { __mockCreate: jest.Mock }).__mockCreate = mockCreate;
  return { __esModule: true, default: MockConstructor };
});

import OpenAI from 'openai';
import mongoose from 'mongoose';
import MatchRecord, { Freshness } from '../models/MatchRecord';
import JobListing from '../models/JobListing';
import User from '../models/User';
import RejectionSignal from '../models/RejectionSignal';
import { getActiveRejectionBlocks } from '../services/rejectionSignalService';
import { runBackfill, BackfillOptions } from '../scripts/backfillRejectionSignals';

const mockCreate = (OpenAI as unknown as { __mockCreate: jest.Mock }).__mockCreate;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function reply(signal: object | undefined) {
  return {
    choices: [{ message: { content: JSON.stringify({ updatedInsights: 'REWRITTEN BY LLM', signal }) } }],
  };
}
const TEMP30 = { scope: 'company', duration: 'temporary', cooldownDays: 30, rationale: 'cap' };
const ROLE_TEMP = { scope: 'role', duration: 'temporary', cooldownDays: 30, rationale: 'role' };

const quiet = (extra: Partial<BackfillOptions> = {}): BackfillOptions & { lines: string[] } => {
  const lines: string[] = [];
  return { apply: false, yes: false, log: (l) => lines.push(l), lines, ...extra };
};

async function mkUser(extra: object = {}) {
  const _id = new mongoose.Types.ObjectId();
  await User.create({
    _id,
    name: 'Backfill',
    email: `bf-${_id.toString()}@example.com`,
    password: 'hashed',
    isVerified: true,
    ...extra,
  });
  return (await User.findById(_id))!;
}

let jobSeq = 0;
async function mkJob(company: string, title = 'Backend Engineer') {
  jobSeq++;
  return JobListing.create({
    title,
    company,
    location: ['Remote'],
    source: 'test',
    description: 'desc',
    url: `https://example.com/${jobSeq}`,
    postedDate: new Date(),
  });
}

// Creates a match then forces updatedAt (the rejection time) bypassing mongoose timestamps
async function mkMatch(
  userId: mongoose.Types.ObjectId,
  jobId: mongoose.Types.ObjectId,
  fields: object,
  rejectedDaysAgo: number
) {
  const m = await MatchRecord.create({
    userId,
    jobId,
    matchScore: 80,
    verdict: 'Strong match',
    reasoning: 'r',
    freshness: Freshness.FRESH,
    clicked: false,
    skipped: false,
    applied: null,
    ...fields,
  });
  await MatchRecord.collection.updateOne({ _id: m._id as mongoose.Types.ObjectId },{ $set: { updatedAt: daysAgo(rejectedDaysAgo) } });
  return m;
}

const skipFields = (category = 'other', details = 'process was tedious') => ({
  skipped: true,
  skipReason: { category, details },
});

beforeEach(() => mockCreate.mockReset());

describe('backfill selection', () => {
  it('takes user-entered skips and "No" answers, excludes auto-skips, undone skips and answered-yes rows', async () => {
    const user = await mkUser();
    const [a, b, c, d, e] = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => mkJob(n)));
    const valid = await mkMatch(user._id as mongoose.Types.ObjectId, a._id as mongoose.Types.ObjectId, skipFields(), 5);
    const no = await mkMatch(user._id as mongoose.Types.ObjectId, b._id as mongoose.Types.ObjectId, { applied: false, notAppliedReason: { category: 'other', details: 'x' } }, 5);
    await mkMatch(user._id as mongoose.Types.ObjectId, c._id as mongoose.Types.ObjectId, { ...skipFields(), verdict: 'skipped' }, 5); // auto-skip
    await mkMatch(user._id as mongoose.Types.ObjectId, d._id as mongoose.Types.ObjectId, { skipped: false, skipReason: { category: 'other' } }, 5); // unskipped
    await mkMatch(user._id as mongoose.Types.ObjectId, e._id as mongoose.Types.ObjectId, { applied: true, notAppliedReason: { category: 'other' } }, 5); // later said yes
    mockCreate.mockResolvedValue(reply(TEMP30));

    const res = await runBackfill(quiet({ apply: true, yes: true }));

    expect(res.rows).toBe(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const rows = await RejectionSignal.find({});
    expect(rows.map((r) => `${r.matchId}:${r.source}`).sort()).toEqual(
      [`${valid._id}:skip`, `${no._id}:not_applied`].sort()
    );
  });

  it('is idempotent: a second apply run creates nothing and makes no LLM calls', async () => {
    const user = await mkUser();
    const job = await mkJob('Camunda');
    await mkMatch(user._id as mongoose.Types.ObjectId, job._id as mongoose.Types.ObjectId, skipFields(), 5);
    mockCreate.mockResolvedValue(reply(TEMP30));

    await runBackfill(quiet({ apply: true, yes: true }));
    expect(await RejectionSignal.countDocuments()).toBe(1);
    mockCreate.mockClear();

    const second = await runBackfill(quiet({ apply: true, yes: true }));
    expect(second.rows).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await RejectionSignal.countDocuments()).toBe(1);
  });

  it('--user limits to one user and --limit caps rows', async () => {
    const u1 = await mkUser();
    const u2 = await mkUser();
    for (const [u, n] of [[u1, 'P'], [u1, 'Q'], [u2, 'R']] as const) {
      await mkMatch(u._id as mongoose.Types.ObjectId, (await mkJob(n))._id as mongoose.Types.ObjectId, skipFields(), 5);
    }
    mockCreate.mockResolvedValue(reply(TEMP30));

    expect((await runBackfill(quiet({ apply: false, yes: false, userEmail: u1.email }))).rows).toBe(2);
    expect((await runBackfill(quiet({ apply: false, yes: false, limit: 1 }))).rows).toBe(1);
  });
});

describe('original-time semantics', () => {
  it('stores createdAt/blockedUntil from the rejection time so an old cooldown is already expired', async () => {
    const user = await mkUser();
    const oldJob = await mkJob('OldCo');
    const freshJob = await mkJob('FreshCo');
    const old = await mkMatch(user._id as mongoose.Types.ObjectId, oldJob._id as mongoose.Types.ObjectId, skipFields(), 60);
    await mkMatch(user._id as mongoose.Types.ObjectId, freshJob._id as mongoose.Types.ObjectId, skipFields(), 10);
    mockCreate.mockResolvedValue(reply(TEMP30));

    await runBackfill(quiet({ apply: true, yes: true }));

    const oldSig = (await RejectionSignal.findOne({ matchId: old._id }))!;
    const oldAt = (await MatchRecord.findById(old._id))!.updatedAt;
    expect(oldSig.createdAt.getTime()).toBe(oldAt.getTime());
    expect(oldSig.blockedUntil!.getTime()).toBe(oldAt.getTime() + 30 * DAY);
    expect(oldSig.blockedUntil!.getTime()).toBeLessThan(Date.now());

    const { companyBlocks } = await getActiveRejectionBlocks(user._id as mongoose.Types.ObjectId);
    expect(companyBlocks.map((b) => b.company)).toEqual(['FreshCo']);
  });

  it('evaluates the repeat-rejection override chronologically, regardless of insertion order', async () => {
    const user = await mkUser();
    // Created newest-first on purpose
    const jobs = await Promise.all([1, 2, 3].map((i) => mkJob('Tether', `Role ${i}`)));
    const newest = await mkMatch(user._id as mongoose.Types.ObjectId, jobs[2]._id as mongoose.Types.ObjectId, skipFields(), 10);
    const middle = await mkMatch(user._id as mongoose.Types.ObjectId, jobs[1]._id as mongoose.Types.ObjectId, skipFields(), 20);
    const oldest = await mkMatch(user._id as mongoose.Types.ObjectId, jobs[0]._id as mongoose.Types.ObjectId, skipFields(), 30);
    mockCreate.mockResolvedValue(reply(ROLE_TEMP));

    await runBackfill(quiet({ apply: true, yes: true }));

    const scope = async (m: { _id: unknown }) => (await RejectionSignal.findOne({ matchId: m._id }))!.scope;
    expect(await scope(oldest)).toBe('role');
    expect(await scope(middle)).toBe('role');
    expect(await scope(newest)).toBe('company'); // two earlier rejections inside its 45-day window
  });

  it('does not count rejections older than 45 days before the row being evaluated', async () => {
    const user = await mkUser();
    const jobs = await Promise.all([1, 2, 3].map((i) => mkJob('Tether', `Role ${i}`)));
    await mkMatch(user._id as mongoose.Types.ObjectId, jobs[0]._id as mongoose.Types.ObjectId, skipFields(), 200);
    await mkMatch(user._id as mongoose.Types.ObjectId, jobs[1]._id as mongoose.Types.ObjectId, skipFields(), 30);
    const last = await mkMatch(user._id as mongoose.Types.ObjectId, jobs[2]._id as mongoose.Types.ObjectId, skipFields(), 20);
    mockCreate.mockResolvedValue(reply(ROLE_TEMP));

    await runBackfill(quiet({ apply: true, yes: true }));

    expect((await RejectionSignal.findOne({ matchId: last._id }))!.scope).toBe('role');
  });
});

describe('no side effects on learned preferences', () => {
  it('leaves insights and feedbackCount untouched', async () => {
    const lastUpdated = new Date('2026-01-01T00:00:00Z');
    const user = await mkUser({
      learnedPreferences: { insights: 'Original insights.', lastUpdated, feedbackCount: 7 },
    });
    const job = await mkJob('Camunda');
    await mkMatch(user._id as mongoose.Types.ObjectId, job._id as mongoose.Types.ObjectId, skipFields(), 5);
    mockCreate.mockResolvedValue(reply(TEMP30));

    await runBackfill(quiet({ apply: true, yes: true }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const after = (await User.findById(user._id))!;
    expect(after.learnedPreferences?.insights).toBe('Original insights.');
    expect(after.learnedPreferences?.feedbackCount).toBe(7);
    expect(after.learnedPreferences?.lastUpdated.getTime()).toBe(lastUpdated.getTime());
  });
});

describe('modes', () => {
  it('without --yes makes zero LLM calls and writes nothing, even with --apply', async () => {
    const user = await mkUser();
    const job = await mkJob('Camunda');
    await mkMatch(user._id as mongoose.Types.ObjectId, job._id as mongoose.Types.ObjectId, skipFields(), 5);

    const res = await runBackfill(quiet({ apply: true, yes: false }));

    expect(res.rows).toBe(1);
    expect(res.plannedLlmCalls).toBe(1);
    expect(res.llmCalls).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await RejectionSignal.countDocuments()).toBe(0);
  });

  it('dry run with --yes calls the LLM but writes nothing, and shows the override across rows', async () => {
    const user = await mkUser();
    const jobs = await Promise.all([1, 2, 3].map((i) => mkJob('Tether', `Role ${i}`)));
    for (const [i, days] of [30, 20, 10].entries()) {
      await mkMatch(user._id as mongoose.Types.ObjectId, jobs[i]._id as mongoose.Types.ObjectId, skipFields(), days);
    }
    mockCreate.mockResolvedValue(reply(ROLE_TEMP));
    const opts = quiet({ apply: false, yes: true });

    const res = await runBackfill(opts);

    expect(res.llmCalls).toBe(3);
    expect(await RejectionSignal.countDocuments()).toBe(0);
    const rowLines = opts.lines.filter((l) => l.includes('Tether /'));
    expect(rowLines).toHaveLength(3);
    expect(rowLines[0]).toContain('scope=role');
    expect(rowLines[2]).toContain('scope=company');
    expect(rowLines[2]).toContain('ACTIVE');
    expect(res.activeCompanyBlocksByUser[user.email]).toBe(1);
  });

  it('job_inactive rows are excluded; deleted listings use no LLM and persist as skipped', async () => {
    const user = await mkUser();
    const job = await mkJob('Gone Inc');
    const inactive = await mkMatch(user._id as mongoose.Types.ObjectId, job._id as mongoose.Types.ObjectId, skipFields('job_inactive', 'closed'), 5);
    const orphan = await mkMatch(
      user._id as mongoose.Types.ObjectId,
      new mongoose.Types.ObjectId(),
      { applied: false, notAppliedReason: { category: 'other', details: 'x' } },
      5
    );

    const res = await runBackfill(quiet({ apply: true, yes: true }));

    expect(res.rows).toBe(1);
    expect(res.llmCalls).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await RejectionSignal.findOne({ matchId: inactive._id })).toBeNull();
    const b = (await RejectionSignal.findOne({ matchId: orphan._id }))!;
    expect([b.analysisStatus, b.scope]).toEqual(['skipped', 'none']);
  });

  it('records nothing for a failed extraction so a re-run retries it', async () => {
    const user = await mkUser();
    const job = await mkJob('Camunda');
    await mkMatch(user._id as mongoose.Types.ObjectId, job._id as mongoose.Types.ObjectId, skipFields(), 5);
    mockCreate.mockResolvedValueOnce(reply(undefined));

    const first = await runBackfill(quiet({ apply: true, yes: true }));
    expect(first.errors).toBe(1);
    expect(await RejectionSignal.countDocuments()).toBe(0);

    mockCreate.mockResolvedValue(reply(TEMP30));
    await runBackfill(quiet({ apply: true, yes: true }));
    expect(await RejectionSignal.countDocuments()).toBe(1);
  });
});
