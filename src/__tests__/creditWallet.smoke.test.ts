// Smoke tests for creditTransactionOnce — uses global MongoMemoryServer from setup.ts.
// Phase 2a only: proves the atomic claim + $inc core; concurrent adversarial suite is authored separately.

jest.mock("../services/analyticsService", () => ({
  captureLifecycleEvent: jest.fn(),
}));

import mongoose from "mongoose";
import Transaction from "../models/Transaction";
import User from "../models/User";
import { creditTransactionOnce } from "../utils/creditWallet";

async function seedUser(walletBalance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({
    _id: userId,
    name: "Smoke User",
    email: `smoke-${userId}@test.example.com`,
    password: "hashed",
    isVerified: true,
    walletBalance,
    resume: { skills: [], experience: [], education: [], summary: "", certifications: [], languages: [], projects: [], achievements: [], volunteerExperience: [], interests: [] },
    preferences: { jobTypes: [], location: [], remoteOnly: false, minSalary: 0, industries: [], minScore: 30, matchingEnabled: true },
  });
  return userId;
}

async function seedPendingTx(userId: mongoose.Types.ObjectId, orderId: string, amount = 10) {
  return Transaction.create({
    userId,
    type: "credit",
    amount,
    description: `Top-up $${amount}`,
    razorpayOrderId: orderId,
    status: "pending",
    metadata: {},
  });
}

describe("creditTransactionOnce — smoke", () => {
  it("credits the wallet once and sets walletCredited on the transaction", async () => {
    const userId = await seedUser(0);
    await seedPendingTx(userId, "order_smoke_be_1");

    const result = await creditTransactionOnce("order_smoke_be_1", { source: "verify" });

    expect(result.credited).toBe(true);
    expect(result.amount).toBe(10);
    expect(result.newBalance).toBe(10);

    const txn = await Transaction.findOne({ razorpayOrderId: "order_smoke_be_1" });
    expect(txn!.status).toBe("completed");
    expect(txn!.metadata!.walletCredited).toBe(true);
    expect(txn!.metadata!.creditedBy).toBe("verify");

    const user = await User.findById(userId);
    expect(user!.walletBalance).toBe(10);
  });

  it("returns {credited:false} on a second call and does not change balance", async () => {
    const userId = await seedUser(0);
    await seedPendingTx(userId, "order_smoke_be_2", 20);

    await creditTransactionOnce("order_smoke_be_2", { source: "verify" });
    const second = await creditTransactionOnce("order_smoke_be_2", { source: "webhook" });

    expect(second.credited).toBe(false);
    expect(second.userId).toBeUndefined();

    const user = await User.findById(userId);
    expect(user!.walletBalance).toBe(20);
  });

  it("does not re-credit a legacy completed txn that has no walletCredited flag", async () => {
    const userId = await seedUser(50);
    await Transaction.create({
      userId,
      type: "credit",
      amount: 30,
      description: "Legacy top-up",
      razorpayOrderId: "order_smoke_be_legacy",
      status: "completed",
      metadata: {},
    });

    const result = await creditTransactionOnce("order_smoke_be_legacy", { source: "webhook" });

    expect(result.credited).toBe(false);

    const user = await User.findById(userId);
    expect(user!.walletBalance).toBe(50);
  });

  it("stores paymentId when provided", async () => {
    const userId = await seedUser(0);
    await seedPendingTx(userId, "order_smoke_be_3", 5);

    await creditTransactionOnce("order_smoke_be_3", { paymentId: "pay_abc", source: "verify" });

    const txn = await Transaction.findOne({ razorpayOrderId: "order_smoke_be_3" });
    expect(txn!.razorpayPaymentId).toBe("pay_abc");
    expect(txn!.metadata!.paymentId).toBe("pay_abc");
  });
});
