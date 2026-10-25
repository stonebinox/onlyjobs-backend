/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

import mongoose from "mongoose";
import RejectionSignal from "../models/RejectionSignal";
import MatchRecord from "../models/MatchRecord";
import JobListing from "../models/JobListing";
import User from "../models/User";

const mockCreate = jest.fn();
jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: (...a: any[]) => mockCreate(...a) } },
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runBackfill } = require("../scripts/backfillRejectionSignals");

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

type Signal = {
  scope?: string;
  attribute?: string;
  duration?: string;
  cooldownDays?: number;
  rationale?: string;
};
type Resp = Signal | "throw" | "garbage" | "nochoices";

let defaultResp: Resp = { scope: "company", duration: "permanent" };
let rules: Array<[string, Resp]> = [];

function render(r: Resp): any {
  if (r === "throw") throw new Error("boom");
  if (r === "nochoices") return { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const content =
    r === "garbage"
      ? "this is definitely not json {{{"
      : JSON.stringify({ updatedInsights: "insights", signal: r });
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function installMock() {
  mockCreate.mockReset();
  mockCreate.mockImplementation(async (args: any) => {
    const s = JSON.stringify(args);
    for (const [marker, r] of rules) if (s.includes(marker)) return render(r);
    return render(defaultResp);
  });
}

let seq = 0;
const nextId = () => String(++seq).padStart(4, "0");

async function mkUser(email?: string, extra: any = {}) {
  const n = nextId();
  return User.create({
    name: `User ${n}`,
    email: email ?? `u${n}@example.com`,
    password: "x",
    ...extra,
  });
}

async function mkJob(company: string, title?: string) {
  const n = nextId();
  return JobListing.create({
    title: title ?? `Engineer ${n}`,
    company,
    location: ["Remote"],
    source: "test",
    description: "desc",
    url: `https://example.com/job/${n}`,
  });
}

interface MatchOpts {
  at?: Date;
  skipped?: boolean;
  skipCategory?: string | null;
  applied?: boolean | null;
  naCategory?: string | null;
  verdict?: string;
  marker?: string;
  jobId?: mongoose.Types.ObjectId;
}

/** Creates a MatchRecord with an exact updatedAt (written via the raw collection to bypass timestamps). */
async function mkMatch(user: any, job: any, o: MatchOpts = {}) {
  const marker = o.marker ?? `ZZ${nextId()}ZZ`;
  const doc: any = {
    userId: user._id,
    jobId: o.jobId ?? job._id,
    matchScore: 80,
    verdict: o.verdict ?? "match",
    reasoning: "r",
    skipped: o.skipped ?? false,
    applied: o.applied === undefined ? null : o.applied,
  };
  if (o.skipCategory) doc.skipReason = { category: o.skipCategory, details: `${marker} skip` };
  if (o.naCategory) doc.notAppliedReason = { category: o.naCategory, details: `${marker} na` };
  const m = await MatchRecord.create(doc);
  // createdAt a day before the rejection time so the row reads as a user rejection, not a system write
  const rejectedAt = o.at ?? new Date();
  await MatchRecord.collection.updateOne(
    { _id: m._id as any },
    { $set: { updatedAt: rejectedAt, createdAt: new Date(rejectedAt.getTime() - 24 * 60 * 60 * 1000) } }
  );
  return { id: m._id as mongoose.Types.ObjectId, marker };
}

/** A plain skip candidate. */
async function skipCand(
  user: any,
  company: string,
  at: Date,
  category = "role_mismatch",
  marker?: string
) {
  const job = await mkJob(company, `Role ${marker ?? ""} ${nextId()}`);
  const m = await mkMatch(user, job, { at, skipped: true, skipCategory: category, marker });
  return { ...m, jobId: job._id as mongoose.Types.ObjectId };
}

async function naCand(user: any, company: string, at: Date, category = "role_mismatch") {
  const job = await mkJob(company);
  return mkMatch(user, job, { at, applied: false, naCategory: category });
}

const run = (o: Partial<{ apply: boolean; yes: boolean; userEmail: string; limit: number }> = {}) =>
  runBackfill({ apply: true, yes: true, log: () => undefined, ...o });

const sigFor = (matchId: any, source?: string) =>
  RejectionSignal.findOne({ matchId, ...(source ? { source } : {}) }).lean<any>();

const sumActive = (r: any) =>
  Object.values(r.activeCompanyBlocksByUser as Record<string, number>).reduce((a, b) => a + b, 0);

beforeAll(async () => {
  await RejectionSignal.init();
});

beforeEach(() => {
  defaultResp = { scope: "company", duration: "permanent" };
  rules = [];
  installMock();
});

describe("K1 candidate selection", () => {
  it("processes exactly the spec'd candidates and no others", async () => {
    const u = await mkUser();
    const mk = async (o: MatchOpts) => mkMatch(u, await mkJob(`Co${nextId()}`), o);

    const yesSkip = await mk({ skipped: true, skipCategory: "role_mismatch" });
    const autoSkip = await mk({ skipped: true, skipCategory: "role_mismatch", verdict: "skipped" });
    const unskippedWithReason = await mk({ skipped: false, skipCategory: "role_mismatch" });
    const unskippedCleared = await mk({ skipped: false });
    const yesNa = await mk({ applied: false, naCategory: "skills_gap" });
    const appliedTrue = await mk({ applied: true, naCategory: "skills_gap" });
    const appliedNull = await mk({ applied: null, naCategory: "skills_gap" });
    const appliedFalseNoReason = await mk({ applied: false });
    const skippedNoReason = await mk({ skipped: true });

    const r = await run();
    const sigs = await RejectionSignal.find({}).lean<any[]>();
    const got = sigs.map((s) => `${s.matchId}:${s.source}`).sort();
    const want = [`${yesSkip.id}:skip`, `${yesNa.id}:not_applied`].sort();
    expect(got).toEqual(want);
    expect(r.created).toBe(2);
    for (const x of [autoSkip, unskippedWithReason, unskippedCleared, appliedTrue, appliedNull, appliedFalseNoReason, skippedNoReason]) {
      expect(await sigFor(x.id)).toBeNull();
    }
  });

  it("a match that is both skipped and not-applied yields one signal per source", async () => {
    const u = await mkUser();
    const job = await mkJob("BothCo");
    const m = await mkMatch(u, job, {
      skipped: true,
      skipCategory: "role_mismatch",
      applied: false,
      naCategory: "skills_gap",
    });
    await run();
    const sigs = await RejectionSignal.find({ matchId: m.id }).lean<any[]>();
    expect(sigs.map((s) => s.source).sort()).toEqual(["not_applied", "skip"]);
  });

  it("an auto-skip (verdict 'skipped') that is also applied=false with a reason is a not_applied candidate only", async () => {
    const u = await mkUser();
    const job = await mkJob("AutoCo");
    const m = await mkMatch(u, job, {
      skipped: true,
      skipCategory: "role_mismatch",
      verdict: "skipped",
      applied: false,
      naCategory: "skills_gap",
    });
    await run();
    const sigs = await RejectionSignal.find({ matchId: m.id }).lean<any[]>();
    expect(sigs.map((s) => s.source)).toEqual(["not_applied"]);
  });
});

describe("K2 idempotency", () => {
  it("a second full run creates nothing and makes no LLM calls", async () => {
    const u = await mkUser();
    await skipCand(u, "A", new Date(Date.now() - 3 * DAY));
    await naCand(u, "B", new Date(Date.now() - 2 * DAY));
    const first = await run();
    expect(first.created).toBe(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    mockCreate.mockClear();
    const second = await run();
    expect(second.created).toBe(0);
    expect(second.llmCalls).toBe(0);
    expect(second.plannedLlmCalls).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await RejectionSignal.countDocuments()).toBe(2);
  });

  it("existing active AND revoked signals are never reprocessed or modified", async () => {
    const u = await mkUser();
    const a = await skipCand(u, "ActiveCo", new Date(Date.now() - 3 * DAY));
    const b = await skipCand(u, "RevokedCo", new Date(Date.now() - 3 * DAY));
    const base = (x: any, status: string) => ({
      userId: u._id,
      matchId: x.id,
      jobId: x.jobId,
      source: "skip",
      category: "role_mismatch",
      scope: "none",
      duration: "none",
      status,
      revokedAt: status === "revoked" ? new Date() : null,
      analysisStatus: "ok",
    });
    await RejectionSignal.create(base(a, "active"));
    await RejectionSignal.create(base(b, "revoked"));
    const r = await run();
    expect(r.created).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect((await sigFor(a.id))!.scope).toBe("none");
    const rb = await sigFor(b.id);
    expect(rb!.status).toBe("revoked");
    expect(rb!.scope).toBe("none");
    expect(await RejectionSignal.countDocuments()).toBe(2);
  });

  it("an existing 'skip' signal does not suppress the same match's 'not_applied' candidate", async () => {
    const u = await mkUser();
    const job = await mkJob("TwoSrc");
    const m = await mkMatch(u, job, {
      skipped: true,
      skipCategory: "role_mismatch",
      applied: false,
      naCategory: "skills_gap",
    });
    await RejectionSignal.create({
      userId: u._id,
      matchId: m.id,
      jobId: job._id,
      source: "skip",
      category: "role_mismatch",
      analysisStatus: "ok",
    });
    const r = await run();
    expect(r.created).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(await sigFor(m.id, "not_applied")).not.toBeNull();
  });
});

describe("K3 apply / yes gates", () => {
  it("only apply=true && yes=true writes; only yes=true spends LLM calls", async () => {
    const u = await mkUser();
    await skipCand(u, "G1", new Date(Date.now() - 3 * DAY));
    await naCand(u, "G2", new Date(Date.now() - 2 * DAY));

    const dry = await runBackfill({ apply: false, yes: false, log: () => undefined });
    expect(dry.rows).toBe(2);
    expect(dry.plannedLlmCalls).toBe(2);
    expect(dry.llmCalls).toBe(0);
    expect(dry.created).toBe(0);
    expect(Number.isFinite(dry.estimatedCostUsd)).toBe(true);
    expect(dry.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await RejectionSignal.countDocuments()).toBe(0);

    const applyNoYes = await runBackfill({ apply: true, yes: false, log: () => undefined });
    expect(applyNoYes.rows).toBe(2);
    expect(applyNoYes.plannedLlmCalls).toBe(2);
    expect(applyNoYes.llmCalls).toBe(0);
    expect(applyNoYes.created).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await RejectionSignal.countDocuments()).toBe(0);

    const yesNoApply = await runBackfill({ apply: false, yes: true, log: () => undefined });
    expect(yesNoApply.llmCalls).toBe(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(yesNoApply.created).toBe(0);
    expect(await RejectionSignal.countDocuments()).toBe(0);

    mockCreate.mockClear();
    const both = await runBackfill({ apply: true, yes: true, log: () => undefined });
    expect(both.llmCalls).toBe(2);
    expect(both.created).toBe(2);
    expect(await RejectionSignal.countDocuments()).toBe(2);
  });
});

describe("K4 no-LLM rows", () => {
  it("job_inactive rows are excluded entirely; deleted-listing rows are not planned/called and stored as skipped/none", async () => {
    const u = await mkUser();
    const live = await skipCand(u, "LiveCo", new Date(Date.now() - 3 * DAY));
    const inactiveJob = await mkJob("InactiveCo");
    const inactive = await mkMatch(u, inactiveJob, {
      at: new Date(Date.now() - 3 * DAY),
      skipped: true,
      skipCategory: "job_inactive",
    });
    const ghost = await mkMatch(u, null, {
      at: new Date(Date.now() - 3 * DAY),
      skipped: true,
      skipCategory: "role_mismatch",
      jobId: new mongoose.Types.ObjectId(),
    });

    const dry = await runBackfill({ apply: false, yes: false, log: () => undefined });
    expect(dry.rows).toBe(2);
    expect(dry.plannedLlmCalls).toBe(1);

    mockCreate.mockClear();
    const r = await run();
    expect(r.created).toBe(2);
    expect(r.llmCalls).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const s = await sigFor(ghost.id);
    expect(s).not.toBeNull();
    expect(s!.analysisStatus).toBe("skipped");
    expect(s!.scope).toBe("none");
    expect(await sigFor(inactive.id)).toBeNull();
    expect((await sigFor(live.id))!.analysisStatus).toBe("ok");
  });
});

describe("K5 original-time semantics", () => {
  it("stores createdAt = rejection time; blockedUntil = time + cooldown; old cooldown already expired", async () => {
    const u = await mkUser();
    defaultResp = { scope: "company", duration: "temporary", cooldownDays: 30 };
    const t60 = new Date(Date.now() - 60 * DAY);
    const t10 = new Date(Date.now() - 10 * DAY);
    const old = await skipCand(u, "OldCo", t60);
    const recent = await skipCand(u, "RecentCo", t10);

    const dry = await runBackfill({ apply: false, yes: true, log: () => undefined });
    expect(sumActive(dry)).toBe(1);

    const r = await run();
    expect(sumActive(r)).toBe(1);
    const so = (await sigFor(old.id))!;
    const sr = (await sigFor(recent.id))!;
    expect(so.createdAt.getTime()).toBe(t60.getTime());
    expect(sr.createdAt.getTime()).toBe(t10.getTime());
    expect(so.blockedUntil.getTime()).toBe(t60.getTime() + 30 * DAY);
    expect(sr.blockedUntil.getTime()).toBe(t10.getTime() + 30 * DAY);
    expect(so.blockedUntil.getTime()).toBeLessThan(Date.now());
    expect(sr.blockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("cooldown boundary: 1 minute left is active, 1 minute past is expired (30d and 7d cooldowns)", async () => {
    const u = await mkUser();
    const now = Date.now();
    const a30 = await skipCand(u, "A30", new Date(now - 30 * DAY + 5 * MIN));
    const e30 = await skipCand(u, "E30", new Date(now - 30 * DAY - 5 * MIN));
    defaultResp = { scope: "company", duration: "temporary", cooldownDays: 30 };
    const r30 = await run();
    expect(sumActive(r30)).toBe(1);
    expect((await sigFor(a30.id))!.blockedUntil.getTime()).toBeGreaterThan(Date.now());
    expect((await sigFor(e30.id))!.blockedUntil.getTime()).toBeLessThan(Date.now());

    const a7 = await skipCand(u, "A7", new Date(now - 7 * DAY + 5 * MIN));
    const e7 = await skipCand(u, "E7", new Date(now - 7 * DAY - 5 * MIN));
    defaultResp = { scope: "company", duration: "temporary", cooldownDays: 7 };
    await run();
    expect((await sigFor(a7.id))!.blockedUntil.getTime()).toBeGreaterThan(Date.now());
    expect((await sigFor(e7.id))!.blockedUntil.getTime()).toBeLessThan(Date.now());
    expect((await sigFor(a7.id))!.blockedUntil.getTime()).toBe(now - 7 * DAY + 5 * MIN + 7 * DAY);
  });

  it("permanent blocks have blockedUntil null and are active regardless of age", async () => {
    const u = await mkUser();
    defaultResp = { scope: "company", duration: "permanent" };
    const m = await skipCand(u, "PermCo", new Date(Date.now() - 400 * DAY));
    const r = await run();
    const s = (await sigFor(m.id))!;
    expect(s.blockedUntil ?? null).toBeNull();
    expect(s.duration).toBe("permanent");
    expect(sumActive(r)).toBe(1);
  });
});

describe("K6 repeat-rejection override", () => {
  const T0 = () => new Date(Date.now() - 5 * DAY);
  const before = (t0: Date, days: number) => new Date(t0.getTime() - days * DAY);
  const after = (t0: Date, days: number) => new Date(t0.getTime() + days * DAY);

  beforeEach(() => {
    // Every row is judged a role-level, permanent rejection -> override target is 'company'.
    defaultResp = { scope: "role", duration: "permanent" };
  });

  async function scopes(ms: Array<{ id: any }>) {
    return Promise.all(ms.map(async (m) => (await sigFor(m.id))!.scope));
  }

  it("2 earlier same-company rejections at 44 and 20 days force 'company' (dry run + apply)", async () => {
    const u = await mkUser();
    const t0 = T0();
    // created target-first to catch processing in DB order rather than chronological order
    const target = await skipCand(u, "Acme", t0);
    const b = await skipCand(u, "Acme", before(t0, 20));
    const a = await skipCand(u, "Acme", before(t0, 44));

    const dry = await runBackfill({ apply: false, yes: true, log: () => undefined });
    expect(sumActive(dry)).toBe(1);
    expect(await RejectionSignal.countDocuments()).toBe(0);

    const r = await run();
    expect(sumActive(r)).toBe(1);
    expect(await scopes([a, b, target])).toEqual(["role", "role", "company"]);
  });

  it("window boundary: earlier rejection at 46 days does not count (44 does)", async () => {
    const u = await mkUser();
    const t0 = T0();
    const target = await skipCand(u, "Acme", t0);
    const near = await skipCand(u, "Acme", before(t0, 20));
    const far = await skipCand(u, "Acme", before(t0, 46));

    const dry = await runBackfill({ apply: false, yes: true, log: () => undefined });
    expect(sumActive(dry)).toBe(0);
    await run();
    expect(await scopes([far, near, target])).toEqual(["role", "role", "role"]);
  });

  it("one 44-day and one 46-day earlier -> only one counted -> no override", async () => {
    const u = await mkUser();
    const t0 = T0();
    const target = await skipCand(u, "Acme", t0);
    await skipCand(u, "Acme", before(t0, 44));
    await skipCand(u, "Acme", before(t0, 46.5));
    await run();
    expect((await sigFor(target.id))!.scope).toBe("role");
  });

  it("is chronological: later rejections do not count toward an earlier row", async () => {
    const u = await mkUser();
    const t0 = T0().getTime() - 20 * DAY;
    const base = new Date(t0);
    const first = await skipCand(u, "Acme", base);
    const second = await skipCand(u, "Acme", after(base, 10));
    const third = await skipCand(u, "Acme", after(base, 20));

    const dry = await runBackfill({ apply: false, yes: true, log: () => undefined });
    expect(sumActive(dry)).toBe(1);
    await run();
    expect(await scopes([first, second, third])).toEqual(["role", "role", "company"]);
  });

  it("location / salary / job_inactive earlier rows do not count", async () => {
    const u = await mkUser();
    const t0 = T0();
    const target = await skipCand(u, "Acme", t0);
    await skipCand(u, "Acme", before(t0, 10), "location");
    await skipCand(u, "Acme", before(t0, 8), "salary");
    const job = await mkJob("Acme");
    await mkMatch(u, job, { at: before(t0, 6), skipped: true, skipCategory: "job_inactive" });
    const dry = await runBackfill({ apply: false, yes: true, log: () => undefined });
    expect(sumActive(dry)).toBe(0);
    await run();
    expect((await sigFor(target.id))!.scope).toBe("role");
  });

  it("a listing-specific (location/salary) row is never forced to company, even with 2 priors", async () => {
    const u = await mkUser();
    const t0 = T0();
    const loc = await skipCand(u, "Acme", t0, "location");
    const sal = await skipCand(u, "Acme", after(t0, 1), "salary");
    await skipCand(u, "Acme", before(t0, 5));
    await skipCand(u, "Acme", before(t0, 3));
    await run();
    expect((await sigFor(loc.id))!.scope).toBe("role");
    expect((await sigFor(sal.id))!.scope).toBe("role");
  });

  it("earlier rows the AI judged ok+scope none are excluded from the count", async () => {
    const u = await mkUser();
    const t0 = T0();
    const target = await skipCand(u, "Acme", t0);
    await skipCand(u, "Acme", before(t0, 10), "role_mismatch", "NOPE1ZZ");
    await skipCand(u, "Acme", before(t0, 8), "role_mismatch", "NOPE2ZZ");
    rules = [
      ["NOPE1ZZ", { scope: "none", duration: "none" }],
      ["NOPE2ZZ", { scope: "none", duration: "none" }],
    ];
    const dry = await runBackfill({ apply: false, yes: true, log: () => undefined });
    expect(sumActive(dry)).toBe(0);
    await run();
    expect((await sigFor(target.id))!.scope).toBe("role");
  });

  it("only one scope-none prior out of two still leaves count at 1 -> no override; real second prior -> override", async () => {
    const u = await mkUser();
    const t0 = T0();
    const target = await skipCand(u, "Acme", t0);
    await skipCand(u, "Acme", before(t0, 10), "role_mismatch", "NOPE3ZZ");
    await skipCand(u, "Acme", before(t0, 8));
    rules = [["NOPE3ZZ", { scope: "none", duration: "none" }]];
    await run();
    expect((await sigFor(target.id))!.scope).toBe("role");
    // add a third, genuine prior; target already stored (idempotent) so use a fresh later row
    const later = await skipCand(u, "Acme", after(t0, 1));
    await run();
    // later has priors: target(role), 8d(role), 10d(none) -> 2 counted -> forced
    expect((await sigFor(later.id))!.scope).toBe("company");
  });

  it("different company or different user does not count", async () => {
    const u = await mkUser();
    const other = await mkUser();
    const t0 = T0();
    const target = await skipCand(u, "Acme", t0);
    await skipCand(u, "Globex", before(t0, 10));
    await skipCand(other, "Acme", before(t0, 8));
    const dry = await runBackfill({ apply: false, yes: true, log: () => undefined });
    expect(sumActive(dry)).toBe(0);
    await run();
    expect((await sigFor(target.id))!.scope).toBe("role");
  });

  it("not_applied rejections count alongside skips", async () => {
    const u = await mkUser();
    const t0 = T0();
    const target = await skipCand(u, "Acme", t0);
    await naCand(u, "Acme", before(t0, 10));
    await skipCand(u, "Acme", before(t0, 5));
    await run();
    expect((await sigFor(target.id))!.scope).toBe("company");
  });

  it("override counting works with a company name stored differently per listing (K11: 'Duck Duck Go' vs 'DuckDuckGo')", async () => {
    const u = await mkUser();
    const t0 = T0();
    const target = await skipCand(u, "Duck Duck Go", t0);
    const a = await skipCand(u, "DuckDuckGo", before(t0, 10));
    const b = await skipCand(u, "Duck Duck Go", before(t0, 5));
    await run();
    const sa = (await sigFor(a.id))!;
    const sb = (await sigFor(b.id))!;
    const st = (await sigFor(target.id))!;
    expect(sa.companyKey).toBeTruthy();
    expect(sa.companyKey).toBe(sb.companyKey);
    expect(sa.companyKey).toBe(st.companyKey);
    expect(sa.company).toBe("DuckDuckGo");
    expect(sb.company).toBe("Duck Duck Go");
    expect(st.scope).toBe("company");
    expect(sb.scope).toBe("role");
  });

  it("different companies never share a companyKey", async () => {
    const u = await mkUser();
    const x = await skipCand(u, "Duck Duck Go", new Date(Date.now() - DAY));
    const y = await skipCand(u, "Globex Corp", new Date(Date.now() - DAY));
    await run();
    expect((await sigFor(x.id))!.companyKey).not.toBe((await sigFor(y.id))!.companyKey);
  });
});

describe("K7 / K10 no collateral writes", () => {
  it("does not modify learnedPreferences or MatchRecords (dry-with-yes and apply)", async () => {
    const lp = { insights: "ORIGINAL INSIGHTS", lastUpdated: new Date("2026-01-01T00:00:00Z"), feedbackCount: 7 };
    const u = await mkUser(undefined, { learnedPreferences: lp });
    await skipCand(u, "Z1", new Date(Date.now() - 3 * DAY));
    await naCand(u, "Z2", new Date(Date.now() - 2 * DAY));
    defaultResp = { scope: "company", duration: "permanent" };
    rules = [];

    const snapMatches = async () =>
      JSON.stringify(await MatchRecord.collection.find({}).sort({ _id: 1 }).toArray());
    const beforeMatches = await snapMatches();

    await runBackfill({ apply: false, yes: true, log: () => undefined });
    await run();

    const after = (await User.findById(u._id).lean<any>())!;
    expect(after.learnedPreferences.insights).toBe("ORIGINAL INSIGHTS");
    expect(after.learnedPreferences.feedbackCount).toBe(7);
    expect(new Date(after.learnedPreferences.lastUpdated).getTime()).toBe(lp.lastUpdated.getTime());
    expect(await snapMatches()).toBe(beforeMatches);
    expect(await RejectionSignal.countDocuments()).toBe(2);
  });

  it("does not create learnedPreferences for a user that had none", async () => {
    const u = await mkUser();
    await skipCand(u, "Z1", new Date(Date.now() - 3 * DAY));
    await run();
    const after = (await User.findById(u._id).lean<any>())!;
    expect(after.learnedPreferences).toBeUndefined();
  });
});

describe("K8 userEmail / limit", () => {
  it("userEmail restricts to one user", async () => {
    const u1 = await mkUser("one@example.com");
    const u2 = await mkUser("two@example.com");
    for (let i = 0; i < 3; i++) await skipCand(u1, `C1-${i}`, new Date(Date.now() - DAY));
    for (let i = 0; i < 2; i++) await skipCand(u2, `C2-${i}`, new Date(Date.now() - DAY));

    const dry = await runBackfill({ apply: false, yes: false, userEmail: "one@example.com", log: () => undefined });
    expect(dry.rows).toBe(3);
    expect(dry.plannedLlmCalls).toBe(3);

    const r = await run({ userEmail: "one@example.com" });
    expect(r.created).toBe(3);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    const sigs = await RejectionSignal.find({}).lean<any[]>();
    expect(sigs).toHaveLength(3);
    expect(sigs.every((s) => String(s.userId) === String(u1._id))).toBe(true);
  });

  it("unknown userEmail processes nothing", async () => {
    const u1 = await mkUser("one@example.com");
    await skipCand(u1, "C", new Date(Date.now() - DAY));
    const r = await run({ userEmail: "nobody@example.com" });
    expect(r.created).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await RejectionSignal.countDocuments()).toBe(0);
  });

  it("limit caps processed candidates; a later unlimited run finishes the rest", async () => {
    const u = await mkUser();
    for (let i = 0; i < 5; i++) await skipCand(u, `L${i}`, new Date(Date.now() - (i + 1) * DAY));

    const dry = await runBackfill({ apply: false, yes: false, limit: 2, log: () => undefined });
    expect(dry.rows).toBe(2);
    expect(dry.plannedLlmCalls).toBe(2);

    const r = await run({ limit: 2 });
    expect(r.created).toBe(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(await RejectionSignal.countDocuments()).toBe(2);

    const r2 = await run();
    expect(r2.created).toBe(3);
    expect(await RejectionSignal.countDocuments()).toBe(5);
  });

  it("limit counts no-LLM rows too", async () => {
    const u = await mkUser();
    for (let i = 0; i < 3; i++) {
      await mkMatch(u, null, {
        skipped: true,
        skipCategory: "role_mismatch",
        jobId: new mongoose.Types.ObjectId(),
      });
    }
    const r = await run({ limit: 2 });
    expect(r.created).toBe(2);
    expect(await RejectionSignal.countDocuments()).toBe(2);
  });
});

describe("K9 LLM failures", () => {
  it("throw / non-JSON / empty-choices rows write nothing, count as errors, others succeed; rerun retries them", async () => {
    const u = await mkUser();
    const t = new Date(Date.now() - 3 * DAY);
    const ok1 = await skipCand(u, "Ok1", t, "role_mismatch", "OK1ZZ");
    const bad1 = await skipCand(u, "Bad1", t, "role_mismatch", "BAD1ZZ");
    const bad2 = await skipCand(u, "Bad2", t, "role_mismatch", "BAD2ZZ");
    const bad3 = await skipCand(u, "Bad3", t, "role_mismatch", "BAD3ZZ");
    const ok2 = await skipCand(u, "Ok2", t, "role_mismatch", "OK2ZZ");
    rules = [
      ["BAD1ZZ", "throw"],
      ["BAD2ZZ", "garbage"],
      ["BAD3ZZ", "nochoices"],
    ];

    const r = await run();
    expect(r.errors).toBe(3);
    expect(r.created).toBe(2);
    expect(await sigFor(ok1.id)).not.toBeNull();
    expect(await sigFor(ok2.id)).not.toBeNull();
    for (const b of [bad1, bad2, bad3]) expect(await sigFor(b.id)).toBeNull();
    expect(await RejectionSignal.countDocuments()).toBe(2);

    // fixed LLM -> the failed rows are retried and the ok rows are untouched
    rules = [];
    mockCreate.mockClear();
    const r2 = await run();
    expect(r2.errors).toBe(0);
    expect(r2.created).toBe(3);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(await RejectionSignal.countDocuments()).toBe(5);
    for (const b of [bad1, bad2, bad3]) expect((await sigFor(b.id))!.analysisStatus).toBe("ok");
  });

  it("a failing LLM in dry-with-yes mode still writes nothing", async () => {
    const u = await mkUser();
    await skipCand(u, "X", new Date(Date.now() - DAY));
    defaultResp = "throw";
    const r = await runBackfill({ apply: false, yes: true, log: () => undefined });
    expect(r.created).toBe(0);
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect(await RejectionSignal.countDocuments()).toBe(0);
  });
});
