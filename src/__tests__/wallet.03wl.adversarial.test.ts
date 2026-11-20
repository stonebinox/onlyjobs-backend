/**
 * onlyjobs-03wl backend adversarial tests: Transaction.chargeKey unique partial index (R2) and
 * GET /api/wallet/transactions must hide pending debits (R7). Oracle = task requirements only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-03wl";
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_dummy";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "dummy_secret";

import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";

import Transaction from "../models/Transaction";
import User from "../models/User";
import walletRoutes from "../routes/walletRoutes";

const app = express();
app.use(express.json());
app.use("/api/wallet", walletRoutes);

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  await Transaction.createIndexes();
});

async function seedUser(email = "w03wl@example.com") {
  const u = await User.create({ name: "W", email, password: "x", isVerified: true, walletBalance: 5 });
  const token = jwt.sign({ id: u.id }, process.env.JWT_SECRET!);
  return { u, token };
}

describe("R2 chargeKey unique partial index (backend copy of the model)", () => {
  const mk = (userId: mongoose.Types.ObjectId, chargeKey?: string) => ({
    userId,
    type: "debit" as const,
    amount: 0.3,
    description: "Daily matching fee",
    status: "pending" as const,
    ...(chargeKey ? { chargeKey } : {}),
  });

  it("index is unique + partial on string chargeKey", async () => {
    const idx = await Transaction.collection.indexes();
    const ck = idx.find((i) => i.key && (i.key as Record<string, number>).chargeKey === 1);
    expect(ck).toBeDefined();
    expect(ck!.unique).toBe(true);
    expect(JSON.stringify(ck!.partialFilterExpression)).toContain("string");
  });

  it("8 concurrent creates with one chargeKey -> exactly one wins, rest 11000", async () => {
    const u = oid();
    const key = `daily:${u}:2031-02-01`;
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => Transaction.create(mk(u, key))));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const bad = rs.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(bad).toHaveLength(7);
    for (const b of bad) expect(b.reason.code).toBe(11000);
  });

  it("rows with no chargeKey (existing wallet credits/debits) never collide", async () => {
    const u = oid();
    for (let i = 0; i < 4; i++) await Transaction.create({ userId: u, type: "credit", amount: 5, description: "Top-up", status: "completed" });
    expect(await Transaction.countDocuments({ userId: u })).toBe(4);
  });

  it("a pre-existing duplicate-free legacy collection can still build the index (createIndexes resolves)", async () => {
    const u = oid();
    await Transaction.collection.insertMany([
      { userId: u, type: "debit", amount: 0.3, description: "legacy", status: "completed", timestamp: new Date() },
      { userId: u, type: "debit", amount: 0.3, description: "legacy", status: "completed", timestamp: new Date() },
    ] as never);
    await expect(Transaction.createIndexes()).resolves.not.toThrow();
  });
});

describe("R7 GET /api/wallet/transactions hides pending debits", () => {
  it("requires auth (protected)", async () => {
    const r = await request(app).get("/api/wallet/transactions");
    expect(r.status).toBe(401);
  });

  it("pending debit hidden; completed debit and completed credit shown", async () => {
    const { u, token } = await seedUser();
    await Transaction.create({ userId: u._id, type: "debit", amount: 0.3, description: "PENDING-DEBIT-MARKER", status: "pending", chargeKey: `daily:${u.id}:2031-03-01` });
    await Transaction.create({ userId: u._id, type: "debit", amount: 0.3, description: "COMPLETED-DEBIT-MARKER", status: "completed", chargeKey: `daily:${u.id}:2031-03-02` });
    await Transaction.create({ userId: u._id, type: "credit", amount: 5, description: "CREDIT-MARKER", status: "completed" });
    const r = await request(app).get("/api/wallet/transactions").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain("PENDING-DEBIT-MARKER");
    expect(body).toContain("COMPLETED-DEBIT-MARKER");
    expect(body).toContain("CREDIT-MARKER");
  });

  it("pending debit WITHOUT a chargeKey is hidden too (hide is by status, not by key)", async () => {
    const { u, token } = await seedUser("w2-03wl@example.com");
    await Transaction.create({ userId: u._id, type: "debit", amount: 0.3, description: "PENDING-NOKEY-MARKER", status: "pending" });
    await Transaction.create({ userId: u._id, type: "credit", amount: 5, description: "CREDIT-2-MARKER", status: "completed" });
    const r = await request(app).get("/api/wallet/transactions").set("Authorization", `Bearer ${token}`);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain("PENDING-NOKEY-MARKER");
    expect(body).toContain("CREDIT-2-MARKER");
  });

  it("many pending debits do not crowd out completed rows (if paginated, completed still appear)", async () => {
    const { u, token } = await seedUser("w3-03wl@example.com");
    await Transaction.create({ userId: u._id, type: "credit", amount: 5, description: "OLD-CREDIT-MARKER", status: "completed", timestamp: new Date(Date.now() - 86400000) });
    for (let i = 0; i < 30; i++) {
      await Transaction.create({ userId: u._id, type: "debit", amount: 0.3, description: `PENDING-BULK-${i}`, status: "pending", chargeKey: `daily:${u.id}:2032-01-${i}` });
    }
    const r = await request(app).get("/api/wallet/transactions").set("Authorization", `Bearer ${token}`);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain("PENDING-BULK-");
    expect(body).toContain("OLD-CREDIT-MARKER");
  });

  it("other users' transactions never leak", async () => {
    const a = await seedUser("a-03wl@example.com");
    const b = await seedUser("b-03wl@example.com");
    await Transaction.create({ userId: b.u._id, type: "credit", amount: 5, description: "B-ONLY-MARKER", status: "completed" });
    const r = await request(app).get("/api/wallet/transactions").set("Authorization", `Bearer ${a.token}`);
    expect(JSON.stringify(r.body)).not.toContain("B-ONLY-MARKER");
  });
});
