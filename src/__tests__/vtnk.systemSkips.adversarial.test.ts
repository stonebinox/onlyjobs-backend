process.env.JWT_SECRET = "test-jwt-secret";
process.env.OPENAI_API_KEY = "test-key";

const mockCreate = jest.fn();
jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: (...a: any[]) => mockCreate(...a) } },
  })),
}));

import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import User from "../models/User";
import JobListing from "../models/JobListing";
import MatchRecord, { Freshness } from "../models/MatchRecord";
import RejectionSignal from "../models/RejectionSignal";
import { runBackfill } from "../scripts/backfillRejectionSignals";
import {
  NON_LEARNING_CATEGORIES,
  extractRejectionSignal,
  analyzeRejectionAndUpdatePreferences,
} from "../services/preferenceLearningService";
import { generateToken } from "../utils/generateToken";
import matchRoutes from "../routes/matchRoutes";

const LANDMINE = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          updatedInsights: "x",
          signal: { scope: "company", duration: "permanent" },
        }),
      },
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

const BASE = new Date("2026-03-01T12:00:00.000Z");
let seq = 0;

const makeUser = async (email = `u${++seq}@example.com`) =>
  User.create({ name: "T", email, password: "password123", isVerified: true });

const makeJob = async (marker: string) =>
  JobListing.create({
    title: `Title ${marker}`,
    company: `Co ${marker}`,
    location: ["Remote"],
    source: "test",
    description: "desc",
    url: `https://example.com/${marker}-${++seq}`,
    postedDate: new Date(),
  });

interface RowOpts {
  source?: "skip" | "not_applied";
  category: string;
  details?: string;
  verdict?: string;
  gapMs?: number | null; // null => no createdAt (legacy)
}

const makeRow = async (user: any, marker: string, o: RowOpts) => {
  const job = await makeJob(marker);
  const source = o.source ?? "skip";
  const reason = { category: o.category, details: o.details };
  const doc = await MatchRecord.create({
    userId: user._id,
    jobId: job._id,
    matchScore: 60,
    verdict: o.verdict ?? "Strong match",
    reasoning: "r",
    freshness: Freshness.FRESH,
    clicked: false,
    skipped: source === "skip",
    applied: source === "skip" ? null : false,
    ...(source === "skip" ? { skipReason: reason } : { notAppliedReason: reason }),
  } as any);
  const gap = o.gapMs === undefined ? 5000 : o.gapMs;
  if (gap === null) {
    await MatchRecord.collection.updateOne(
      { _id: doc._id as any },
      { $set: { updatedAt: new Date(BASE.getTime() + 5000) }, $unset: { createdAt: "" } }
    );
  } else {
    await MatchRecord.collection.updateOne(
      { _id: doc._id as any },
      { $set: { createdAt: BASE, updatedAt: new Date(BASE.getTime() + gap) } }
    );
  }
  return doc;
};

const callsText = () => JSON.stringify(mockCreate.mock.calls);
const called = (marker: string) => callsText().includes(marker);
const noop = () => {};

const run = (o: Partial<{ apply: boolean; yes: boolean; userEmail: string }> = {}) =>
  runBackfill({ apply: false, yes: true, log: noop, ...o });

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(LANDMINE);
});

// Each case: the single row is excluded; every other condition is eligible.
describe("vtnk backfill: independent exclusion rules", () => {
  const verdicts = ["Weak match", "No match", "Strong match", "skipped"];
  const sources: Array<"skip" | "not_applied"> = ["skip", "not_applied"];

  for (const source of sources) {
    for (const verdict of verdicts) {
      it(`R1 relevance excluded (${source}, verdict=${verdict}, 1-day gap)`, async () => {
        const u = await makeUser();
        await makeRow(u, "REL", {
          source, category: "relevance", details: "user words", verdict, gapMs: 86_400_000,
        });
        const res = await run({ apply: true });
        expect(res.rows).toBe(0);
        expect(res.llmCalls).toBe(0);
        expect(mockCreate).not.toHaveBeenCalled();
        expect(await RejectionSignal.countDocuments()).toBe(0);
      });
    }

    for (const prefix of ["Match limit reached", "Evaluation limit reached"]) {
      it(`R2 "${prefix}" excluded (${source}, user category, 1-day gap)`, async () => {
        const u = await makeUser();
        await makeRow(u, "LIM", {
          source, category: "other", details: `${prefix} for today`, gapMs: 86_400_000,
        });
        const res = await run({ apply: true });
        expect(res.rows).toBe(0);
        expect(mockCreate).not.toHaveBeenCalled();
        expect(await RejectionSignal.countDocuments()).toBe(0);
      });
    }

    for (const gap of [0, 500, 999]) {
      it(`R3 gap ${gap}ms excluded (${source}, user category + user text)`, async () => {
        const u = await makeUser();
        await makeRow(u, "GAP", {
          source, category: "salary", details: "pay too low", gapMs: gap,
        });
        const res = await run({ apply: true });
        expect(res.rows).toBe(0);
        expect(mockCreate).not.toHaveBeenCalled();
        expect(await RejectionSignal.countDocuments()).toBe(0);
      });
    }

    for (const gap of [1000, 1001]) {
      it(`R3 gap ${gap}ms included (${source})`, async () => {
        const u = await makeUser();
        await makeRow(u, "EDGE", {
          source, category: "salary", details: "pay too low", gapMs: gap,
        });
        const res = await run();
        expect(res.rows).toBe(1);
        expect(called("EDGE")).toBe(true);
      });
    }

    it(`R3 legacy row without createdAt included (${source})`, async () => {
      const u = await makeUser();
      await makeRow(u, "LEGACY", {
        source, category: "location", details: "too far", gapMs: null,
      });
      const raw = await MatchRecord.collection.findOne({});
      expect(raw!.createdAt).toBeUndefined();
      const res = await run();
      expect(res.rows).toBe(1);
      expect(called("LEGACY")).toBe(true);
    });
  }

  it("R1/R2/R3 dry run (yes:false) excludes too and makes no calls", async () => {
    const u = await makeUser();
    await makeRow(u, "REL", { category: "relevance", details: "x" });
    await makeRow(u, "LIM", { category: "other", details: "Match limit reached" });
    await makeRow(u, "GAP", { category: "other", details: "x", gapMs: 0 });
    await makeRow(u, "OK", { category: "other", details: "x" });
    const res = await run({ yes: false });
    expect(res.rows).toBe(1);
    expect(res.plannedLlmCalls).toBe(1);
    expect(res.llmCalls).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("R4 verdict 'skipped' and job_inactive still excluded", async () => {
    const u = await makeUser();
    await makeRow(u, "VSKIP", { category: "other", details: "x", verdict: "skipped" });
    await makeRow(u, "INACT", { category: "job_inactive", details: "x" });
    const res = await run({ apply: true });
    expect(res.rows).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await RejectionSignal.countDocuments()).toBe(0);
  });

  it("R4 genuine user categories all included", async () => {
    const u = await makeUser();
    for (const c of ["other", "salary", "location", "skills_gap"]) {
      await makeRow(u, `GEN${c.toUpperCase().replace("_", "")}`, { category: c, details: "mine" });
    }
    const res = await run();
    expect(res.rows).toBe(4);
    for (const c of ["OTHER", "SALARY", "LOCATION", "SKILLSGAP"]) {
      expect(called(`GEN${c}`)).toBe(true);
    }
  });
});

describe("vtnk backfill: mixed fixture", () => {
  const setup = async (user: any) => {
    const excluded: string[] = [];
    const included: string[] = [];
    const add = async (m: string, o: RowOpts, inc: boolean) => {
      await makeRow(user, m, o);
      (inc ? included : excluded).push(m);
    };
    await add("MIXREL", { category: "relevance", details: "a", verdict: "Weak match", gapMs: 99999 }, false);
    await add("MIXRELNA", { source: "not_applied", category: "relevance", details: "a", gapMs: 99999 }, false);
    await add("MIXLIM1", { category: "other", details: "Match limit reached today", gapMs: 99999 }, false);
    await add("MIXLIM2", { source: "not_applied", category: "other", details: "Evaluation limit reached", gapMs: 99999 }, false);
    await add("MIXGAP0", { category: "salary", details: "u", gapMs: 0 }, false);
    await add("MIXGAP500", { source: "not_applied", category: "salary", details: "u", gapMs: 500 }, false);
    await add("MIXGAP999", { category: "salary", details: "u", gapMs: 999 }, false);
    await add("MIXVSKIP", { category: "other", details: "u", verdict: "skipped" }, false);
    await add("MIXINACT", { category: "job_inactive", details: "u" }, false);
    await add("MIXINC1", { category: "other", details: "my own words" }, true);
    await add("MIXINC2", { source: "not_applied", category: "salary", details: "too low" }, true);
    await add("MIXINC3", { category: "location", details: "far", gapMs: 1000 }, true);
    await add("MIXINC4", { category: "skills_gap", details: "no", gapMs: null }, true);
    // "limit reached" text not at the start is user text -> eligible
    await add("MIXINC5", { category: "other", details: "I hit the Match limit reached message but also hate it" }, true);
    // relevance-like but different category string
    await add("MIXINC6", { category: "relevance_other", details: "u" }, true);
    return { excluded, included };
  };

  it("exact included set (dry run + real calls)", async () => {
    const u = await makeUser();
    const { excluded, included } = await setup(u);
    const res = await run();
    expect(res.rows).toBe(included.length);
    expect(mockCreate).toHaveBeenCalledTimes(included.length);
    expect(included.filter(called).sort()).toEqual([...included].sort());
    expect(excluded.filter(called)).toEqual([]);
  });

  it("apply:true writes signals only for included matches", async () => {
    const u = await makeUser();
    const { included } = await setup(u);
    const expectedIds = (
      await MatchRecord.find({}).populate("jobId").lean()
    )
      .filter((m: any) => included.some((i) => m.jobId.title.endsWith(i)))
      .map((m: any) => String(m._id))
      .sort();
    expect(expectedIds).toHaveLength(included.length);
    const res = await run({ apply: true });
    expect(res.errors).toBe(0);
    const sigs = await RejectionSignal.find({}).lean();
    expect(sigs.map((s: any) => String(s.matchId)).sort()).toEqual(expectedIds);
  });

  it("--userEmail scoping composes with new filters", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    await makeRow(a, "AOK", { category: "other", details: "x" });
    await makeRow(a, "AREL", { category: "relevance", details: "x" });
    await makeRow(b, "BOK", { category: "other", details: "x" });
    await makeRow(b, "BLIM", { category: "other", details: "Match limit reached" });
    const res = await run({ userEmail: "a@example.com" });
    expect(res.rows).toBe(1);
    expect(called("AOK")).toBe(true);
    for (const m of ["AREL", "BOK", "BLIM"]) expect(called(m)).toBe(false);
  });
});

describe("vtnk live API rejects system category", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/matches", matchRoutes);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(res.statusCode !== 200 ? res.statusCode : 500).json({ error: err.message })
  );

  const fixture = async () => {
    const u = await makeUser();
    const job = await makeJob("API");
    const m = await MatchRecord.create({
      userId: u._id, jobId: job._id, matchScore: 70, verdict: "Strong match",
      reasoning: "r", freshness: Freshness.FRESH, clicked: false, skipped: false, applied: null,
    } as any);
    const before = await MatchRecord.collection.findOne({ _id: m._id as any });
    return { u, m, before, token: generateToken(String(u._id)) };
  };

  const expectUntouched = async (m: any, before: any) => {
    const after = await MatchRecord.collection.findOne({ _id: m._id as any });
    expect(after).toEqual(before);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await RejectionSignal.countDocuments()).toBe(0);
  };

  for (const reason of ["relevance", " relevance "]) {
    it(`POST /skip reason=${JSON.stringify(reason)} -> 400, no mutation`, async () => {
      const { m, before, token } = await fixture();
      const r = await request(app).post("/api/matches/skip")
        .set("Authorization", `Bearer ${token}`)
        .send({ matchId: String(m._id), reason, details: "d" });
      expect(r.status).toBe(400);
      await expectUntouched(m, before);
    });

    it(`POST /skip reason=${JSON.stringify(reason)} without details -> 400`, async () => {
      const { m, before, token } = await fixture();
      const r = await request(app).post("/api/matches/skip")
        .set("Authorization", `Bearer ${token}`)
        .send({ matchId: String(m._id), reason });
      expect(r.status).toBe(400);
      await expectUntouched(m, before);
    });

    it(`POST /applied reason=${JSON.stringify(reason)} -> 400, no mutation`, async () => {
      const { m, before, token } = await fixture();
      const r = await request(app).post("/api/matches/applied")
        .set("Authorization", `Bearer ${token}`)
        .send({ matchId: String(m._id), applied: false, reason });
      expect(r.status).toBe(400);
      await expectUntouched(m, before);
    });
  }

  it("control: POST /skip reason=other -> 200", async () => {
    const { m, token } = await fixture();
    const r = await request(app).post("/api/matches/skip")
      .set("Authorization", `Bearer ${token}`)
      .send({ matchId: String(m._id), reason: "other", details: "not for me" });
    expect(r.status).toBe(200);
    const after = await MatchRecord.findById(m._id).lean();
    expect(after!.skipped).toBe(true);
  });

  it("control: POST /applied applied:false reason=other -> 200", async () => {
    const { m, token } = await fixture();
    const r = await request(app).post("/api/matches/applied")
      .set("Authorization", `Bearer ${token}`)
      .send({ matchId: String(m._id), applied: false, reason: "other", details: "nah" });
    expect(r.status).toBe(200);
  });
});

describe("vtnk preferenceLearningService relevance guard", () => {
  it("NON_LEARNING_CATEGORIES includes job_inactive and relevance", () => {
    const set = new Set<string>(NON_LEARNING_CATEGORIES as any);
    expect(set.has("job_inactive")).toBe(true);
    expect(set.has("relevance")).toBe(true);
    // genuine user categories must not be in it
    for (const c of ["other", "salary", "location", "skills_gap"]) {
      expect(set.has(c)).toBe(false);
    }
  });

  const setupUnit = async () => {
    const user = await makeUser();
    const job = await makeJob("UNIT");
    const m = await MatchRecord.create({
      userId: user._id, jobId: job._id, matchScore: 70, verdict: "Weak match",
      reasoning: "r", freshness: Freshness.FRESH, clicked: false, skipped: true, applied: null,
    } as any);
    return { user, job, m };
  };

  it("extractRejectionSignal returns null, no OpenAI call for relevance", async () => {
    const { user, job, m } = await setupUnit();
    const out = await extractRejectionSignal(user as any, job as any, m as any, {
      category: "relevance", details: "x",
    } as any);
    expect(out).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("analyzeRejectionAndUpdatePreferences returns null, no OpenAI call for relevance", async () => {
    const { user, job, m } = await setupUnit();
    const out = await analyzeRejectionAndUpdatePreferences(user as any, job as any, m as any, {
      category: "relevance", details: "x",
    } as any);
    expect(out).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("control: extractRejectionSignal for 'other' does call OpenAI", async () => {
    const { user, job, m } = await setupUnit();
    await extractRejectionSignal(user as any, job as any, m as any, {
      category: "other", details: "x",
    } as any);
    expect(mockCreate).toHaveBeenCalled();
  });
});

afterAll(() => {
  void mongoose;
});
