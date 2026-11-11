// Smoke tests for onlyjobs-6a4p (Meta CAPI outbox). Phase 2a only: proves each piece
// compiles and runs. The adversarial suite is authored separately.

jest.mock("../services/analyticsService", () => ({
  captureLifecycleEvent: jest.fn(),
}));

import mongoose from "mongoose";
import { Request, Response } from "express";
import User from "../models/User";
import Transaction from "../models/Transaction";
import MatchRecord from "../models/MatchRecord";
import JobListing from "../models/JobListing";
import MetaEventOutbox from "../models/MetaEventOutbox";
import { creditTransactionOnce } from "../utils/creditWallet";
import { buildMetaUserData, sanitizeMetaClick } from "../utils/metaEvents";
import { recordActivation } from "../controllers/matchController";
import { drainMetaEventOutbox, resolveMetaWorkerConfig } from "../services/metaCapi";
import { reconcileMetaEvents } from "../services/metaReconciler";

const START = "2026-01-01T00:00:00.000Z";

function enableMeta() {
  process.env.META_CAPI_ENABLED = "true";
  process.env.META_CAPI_START_AT = START;
  process.env.META_PIXEL_ID = "123";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  process.env.META_GRAPH_API_VERSION = "v99.0";
}

afterEach(() => {
  for (const k of ["META_CAPI_ENABLED", "META_CAPI_START_AT", "META_PIXEL_ID", "META_CAPI_ACCESS_TOKEN", "META_GRAPH_API_VERSION"]) {
    delete process.env[k];
  }
  jest.restoreAllMocks();
});

async function seedUser(extra: Record<string, unknown> = {}) {
  return User.create({
    email: `u${new mongoose.Types.ObjectId()}@test.example.com`,
    password: "hashed",
    walletBalance: 0,
    ...extra,
  });
}

describe("metaEvents helpers", () => {
  it("hashes email (lowercased, trimmed) to a known SHA-256 and drops extra keys", () => {
    const ud = buildMetaUserData({ userId: "u1", email: "  Test@Example.com " });
    // sha256("test@example.com")
    expect(ud.em).toBe("973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b");
    expect(Object.keys(ud).sort()).toEqual(["em", "external_id"]);
  });

  it("sanitizeMetaClick keeps valid values and rejects bad ones", () => {
    expect(sanitizeMetaClick({ fbclid: "abc", fbc: "fb.1.1.abc", fbp: "nope", x: 1 })).toEqual({
      fbclid: "abc",
      fbc: "fb.1.1.abc",
    });
    expect(sanitizeMetaClick({ fbclid: "has space" })).toBeUndefined();
  });
});

describe("creditTransactionOnce Purchase enqueue", () => {
  it("enqueues exactly one Purchase and returns the client fields to winner and loser", async () => {
    enableMeta();
    const user = await seedUser();
    await Transaction.create({
      userId: user._id, type: "credit", amount: 10, description: "Top-up",
      razorpayOrderId: "order_meta_1", status: "pending", metadata: { fbc: "fb.1.1.abc", clientIp: "1.2.3.4" },
    });

    const first = await creditTransactionOnce("order_meta_1", { source: "verify" });
    const second = await creditTransactionOnce("order_meta_1", { source: "webhook" });

    const txn = await Transaction.findOne({ razorpayOrderId: "order_meta_1" });
    expect(first.metaEventId).toBe(`purchase_${txn!._id}`);
    expect(second.credited).toBe(false);
    expect(second.metaEventId).toBe(first.metaEventId);
    expect(second.value).toBe(10);
    expect(second.currency).toBe("USD");

    const rows = await MetaEventOutbox.find({});
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(10);
    expect(rows[0].userData.fbc).toBe("fb.1.1.abc");
    expect(rows[0].userData.client_ip_address).toBe("1.2.3.4");
  });

  it("enqueues nothing when disabled, and no id for a non-credited completed row", async () => {
    const user = await seedUser();
    await Transaction.create({
      userId: user._id, type: "credit", amount: 5, description: "Legacy",
      razorpayOrderId: "order_meta_2", status: "completed", metadata: {},
    });
    const res = await creditTransactionOnce("order_meta_2", { source: "webhook" });
    expect(res).toEqual({ credited: false });
    expect(await MetaEventOutbox.countDocuments()).toBe(0);
  });
});

describe("activation", () => {
  function fakeRes() {
    const res = { body: undefined as unknown, json(b: unknown) { this.body = b; return this; } };
    return res;
  }
  const run = async (userId: unknown) => {
    const res = fakeRes();
    await recordActivation({ user: { _id: userId }, ip: "9.9.9.9", get: () => "ua" } as unknown as Request, res as unknown as Response, jest.fn());
    return res.body;
  };

  it("claims once, enqueues once, then reports alreadyActivated", async () => {
    enableMeta();
    const user = await seedUser({ resume: { skills: ["node"] } });
    const job = await JobListing.create({
      title: "Dev", company: "Co", location: ["Remote"], description: "d", url: "https://x.example/1",
      dedupKey: "https://x.example/1", source: "test", postedDate: new Date(), scrapedDate: new Date(),
    });
    await MatchRecord.create({ userId: user._id, jobId: job._id, matchScore: 80, verdict: "Good", reasoning: "r" });

    const first = await run(user._id);
    const second = await run(user._id);

    expect(first).toEqual({ activated: true, metaEventId: `act_${user._id}` });
    expect(second).toEqual({ activated: false, alreadyActivated: true, metaEventId: `act_${user._id}` });
    expect(await MetaEventOutbox.countDocuments({ eventId: `act_${user._id}` })).toBe(1);
  });

  it("returns no_resume / no_visible_match without claiming", async () => {
    const noResume = await seedUser();
    expect(await run(noResume._id)).toEqual({ activated: false, reason: "no_resume" });
    const noMatch = await seedUser({ resume: { skills: ["node"] } });
    expect(await run(noMatch._id)).toEqual({ activated: false, reason: "no_visible_match" });
    expect((await User.findById(noMatch._id))!.metaActivatedAt).toBeUndefined();
  });
});

describe("drain + reconciler", () => {
  it("boot config requires every var when enabled", () => {
    expect(resolveMetaWorkerConfig().ok).toBe(false);
    enableMeta();
    expect(resolveMetaWorkerConfig().ok).toBe(true);
  });

  it("sends one event per POST, marks sent and scrubs IP/UA; 400 goes dead", async () => {
    enableMeta();
    const user = await seedUser();
    await MetaEventOutbox.create({
      eventId: "reg_a", eventName: "CompleteRegistration", eventTime: 1700000000, userId: user._id,
      userData: { em: "h", client_ip_address: "1.1.1.1", client_user_agent: "ua" }, purgeAt: new Date(Date.now() + 1e9),
    });
    await MetaEventOutbox.create({
      eventId: "reg_b", eventName: "CompleteRegistration", eventTime: 1700000000, userId: user._id,
      userData: { em: "h" }, purgeAt: new Date(Date.now() + 1e9),
    });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ events_received: 1 }) })
      .mockResolvedValueOnce({ status: 400, json: async () => ({}) });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    const cfg = resolveMetaWorkerConfig();
    if (!cfg.ok) throw new Error("config");
    const summary = await drainMetaEventOutbox(cfg.config);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary.sent).toBe(1);
    expect(summary.dead).toBe(1);
    const sent = await MetaEventOutbox.findOne({ status: "sent" }).lean();
    expect(sent!.userData).toEqual({ em: "h" });
  });

  it("reconciler enqueues missing reg_ rows only for users in window", async () => {
    enableMeta();
    const user = await seedUser();
    const result = await reconcileMetaEvents();
    expect(result.registrations).toBe(1);
    expect(await MetaEventOutbox.countDocuments({ eventId: `reg_${user._id}` })).toBe(1);
    expect((await reconcileMetaEvents()).registrations).toBe(0);
  });
});
