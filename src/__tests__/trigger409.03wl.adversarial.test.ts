/**
 * onlyjobs-03wl R9 (backend half): POST /api/matches/trigger-for-me must roll back
 * lastManualMatchAt and return 409 when the background service answers 409 lease_held.
 * The outbound call is mocked at both plausible seams (axios and global fetch).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-03wl";
for (const k of [
  "BACKGROUND_SERVICE_URL", "BACKGROUND_URL", "BACKGROUND_API_URL", "ONLYJOBS_BACKGROUND_URL",
  "BACKGROUND_BASE_URL", "BACKGROUND_JOBS_URL", "BACKGROUND_SERVICE_BASE_URL",
]) process.env[k] = process.env[k] || "http://bg.test";
process.env.INTERNAL_TRIGGER_SECRET = process.env.INTERNAL_TRIGGER_SECRET || "sec-03wl";

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

const mockBgStatus = { status: 409 };
const bgBody = () =>
  mockBgStatus.status === 409 ? { reason: "lease_held", retryAfterMinutes: 7 } : { message: "accepted" };

const mockAxiosCall = jest.fn(async () => {
  if (mockBgStatus.status >= 400) {
    const err: any = new Error(`Request failed with status code ${mockBgStatus.status}`);
    err.isAxiosError = true;
    err.response = { status: mockBgStatus.status, data: bgBody(), headers: {} };
    throw err;
  }
  return { status: mockBgStatus.status, data: bgBody(), headers: {} };
});
jest.mock("axios", () => {
  const fn: any = (...a: unknown[]) => mockAxiosCall(...(a as []));
  for (const m of ["get", "post", "put", "patch", "delete", "request"]) fn[m] = (...a: unknown[]) => mockAxiosCall(...(a as []));
  fn.isAxiosError = (e: any) => !!e && e.isAxiosError === true;
  fn.create = () => fn;
  fn.default = fn;
  fn.__esModule = true;
  return fn;
});

const mockFetch = jest.fn(async () => ({
  ok: mockBgStatus.status < 400,
  status: mockBgStatus.status,
  statusText: "x",
  headers: { get: () => "application/json" },
  json: async () => bgBody(),
  text: async () => JSON.stringify(bgBody()),
}));
(global as any).fetch = mockFetch;

import User from "../models/User";
import matchRoutes from "../routes/matchRoutes";

const app = express();
app.use(express.json());
app.use("/api/matches", matchRoutes);

async function seed(lastManualMatchAt?: Date) {
  const u = await User.create({
    name: "T", email: `t-${Date.now()}-${Math.random()}@example.com`, password: "x", isVerified: true, walletBalance: 10,
    preferences: { matchingEnabled: true, minScore: 50, remoteOnly: false, minSalary: 0, jobTypes: [], location: [], industries: [] },
    resume: { summary: "Senior engineer with a decade of backend experience", skills: ["Node", "TS"], experience: ["Acme 8y"], education: ["BSc"] },
    ...(lastManualMatchAt ? { lastManualMatchAt } : {}),
  });
  return { u, token: jwt.sign({ id: u.id }, process.env.JWT_SECRET!) };
}
const outboundCalls = () => mockAxiosCall.mock.calls.length + mockFetch.mock.calls.length;

beforeEach(() => {
  mockAxiosCall.mockClear();
  mockFetch.mockClear();
  mockBgStatus.status = 409;
});

describe("R9 backend trigger-for-me with background 409", () => {
  it("returns 409 and restores a previous lastManualMatchAt (cooldown NOT consumed)", async () => {
    const prev = new Date(Date.now() - 7 * 24 * 3600 * 1000); // well outside any 6h cooldown
    const { u, token } = await seed(prev);
    const r = await request(app).post("/api/matches/trigger-for-me").set("Authorization", `Bearer ${token}`).send({});
    expect(outboundCalls()).toBeGreaterThan(0); // the harness really reached the background seam
    expect(r.status).toBe(409);
    const after = await User.findById(u._id).lean();
    expect(after!.lastManualMatchAt?.getTime()).toBe(prev.getTime());
  });

  it("returns 409 and leaves lastManualMatchAt unset when the user had never triggered before", async () => {
    const { u, token } = await seed();
    const r = await request(app).post("/api/matches/trigger-for-me").set("Authorization", `Bearer ${token}`).send({});
    expect(outboundCalls()).toBeGreaterThan(0);
    expect(r.status).toBe(409);
    const after = await User.findById(u._id).lean();
    expect(after!.lastManualMatchAt ?? null).toBeNull();
  });

  it("after the 409 the user can immediately retry (not blocked by a 6h cooldown)", async () => {
    const { token } = await seed();
    const r1 = await request(app).post("/api/matches/trigger-for-me").set("Authorization", `Bearer ${token}`).send({});
    expect(r1.status).toBe(409);
    const r2 = await request(app).post("/api/matches/trigger-for-me").set("Authorization", `Bearer ${token}`).send({});
    // a second 409 from background (not a 429/cooldown rejection) proves the cooldown was not consumed
    expect(r2.status).toBe(409);
    expect(outboundCalls()).toBeGreaterThanOrEqual(2);
  });

  it("contrast: when background accepts (202), the cooldown IS consumed (lastManualMatchAt advances)", async () => {
    mockBgStatus.status = 202;
    const prev = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const { u, token } = await seed(prev);
    const r = await request(app).post("/api/matches/trigger-for-me").set("Authorization", `Bearer ${token}`).send({});
    expect(r.status).toBeLessThan(300);
    const after = await User.findById(u._id).lean();
    expect(after!.lastManualMatchAt!.getTime()).toBeGreaterThan(prev.getTime());
  });

  it("unauthenticated -> 401 and no outbound call", async () => {
    const r = await request(app).post("/api/matches/trigger-for-me").send({});
    expect(r.status).toBe(401);
    expect(outboundCalls()).toBe(0);
  });
});
