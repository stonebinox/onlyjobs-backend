// Adversarial concurrency tests for creditTransactionOnce (onlyjobs-4ni)
// Oracle: contract spec only. Implementation files were NOT read.
// Assumes a subtly wrong implementation; tests are designed to EXPOSE double-credit.

jest.mock("../services/analyticsService", () => ({
  captureLifecycleEvent: jest.fn(),
  deriveRegion: jest.fn().mockReturnValue("us"),
  walletBalanceBand: jest.fn().mockReturnValue("low"),
  shutdownAnalytics: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from "mongoose";
import Transaction from "../models/Transaction";
import User from "../models/User";
import { captureLifecycleEvent } from "../services/analyticsService";
import { creditTransactionOnce } from "../utils/creditWallet";

const mockCapture = captureLifecycleEvent as jest.MockedFunction<
  typeof captureLifecycleEvent
>;

let emailSeq = 0;
function freshEmail(): string {
  return `4ni-adv-${++emailSeq}@test.invalid`;
}

async function seedUser(balance = 0): Promise<mongoose.Types.ObjectId> {
  const u = await User.create({
    email: freshEmail(),
    password: "x",
    walletBalance: balance,
  });
  return u._id as mongoose.Types.ObjectId;
}

async function seedPending(
  userId: mongoose.Types.ObjectId,
  orderId: string,
  amount: number
): Promise<void> {
  await Transaction.create({
    userId,
    type: "credit",
    amount,
    description: "top-up",
    razorpayOrderId: orderId,
    status: "pending",
    metadata: { walletCredited: false },
  });
}

beforeEach(() => {
  mockCapture.mockClear();
});

// ---------------------------------------------------------------------------
// T1: Two concurrent calls, same order — balance must NOT double-credit
// Failure mode caught: check-then-act (both reads see "pending" before either
// writes, then both increment walletBalance → balance becomes 10, not 5).
// ---------------------------------------------------------------------------
test("T1: two concurrent calls for same order credit wallet exactly once (balance = 5, not 10)", async () => {
  const userId = await seedUser(0);
  await seedPending(userId, "order_t1", 5);

  const [r1, r2] = await Promise.all([
    creditTransactionOnce("order_t1", { source: "webhook-a" }),
    creditTransactionOnce("order_t1", { source: "webhook-b" }),
  ]);

  const user = await User.findById(userId).lean();
  // PRIMARY GUARD: if this is 10 the implementation is check-then-act (FINDING)
  expect(user!.walletBalance).toBe(5);

  const winners = [r1, r2].filter((r) => r.credited === true);
  const losers = [r1, r2].filter((r) => r.credited === false);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);

  // Analytics must fire exactly once regardless of which call "wins"
  expect(mockCapture).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// T2: Five concurrent calls, same order — idempotency under higher contention
// Failure mode caught: lock-free implementations that race on status read.
// ---------------------------------------------------------------------------
test("T2: five concurrent calls for same order credit exactly once (balance = 5)", async () => {
  const userId = await seedUser(0);
  await seedPending(userId, "order_t2", 5);

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      creditTransactionOnce("order_t2", { source: `caller-${i}` })
    )
  );

  const user = await User.findById(userId).lean();
  expect(user!.walletBalance).toBe(5);

  const winners = results.filter((r) => r.credited === true);
  expect(winners).toHaveLength(1);
  // four callers must see credited:false — not "undefined" or omitted
  const losers = results.filter((r) => r.credited === false);
  expect(losers).toHaveLength(4);

  expect(mockCapture).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// T3: Sequential replay — second call after first commits must be a no-op
// Failure mode caught: guard only checks in-flight status (not persisted flag).
// ---------------------------------------------------------------------------
test("T3: sequential replay: first call credits, second is a no-op", async () => {
  const userId = await seedUser(0);
  await seedPending(userId, "order_t3", 5);

  const first = await creditTransactionOnce("order_t3", { source: "first" });
  expect(first.credited).toBe(true);
  expect(first.newBalance).toBe(5);

  // Reload balance to confirm it was truly persisted before calling again
  const balanceAfterFirst = (await User.findById(userId).lean())!.walletBalance;
  expect(balanceAfterFirst).toBe(5);

  const second = await creditTransactionOnce("order_t3", { source: "second" });
  expect(second.credited).toBe(false);

  const user = await User.findById(userId).lean();
  expect(user!.walletBalance).toBe(5); // unchanged

  // Analytics must not fire for the idempotent replay
  expect(mockCapture).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// T4: Per-order independence — two orders, same user, balance = sum
// Failure mode caught: overly broad guard that blocks all concurrent credits.
// ---------------------------------------------------------------------------
test("T4: two distinct orders credit independently; balance equals sum of both amounts", async () => {
  const userId = await seedUser(0);
  await seedPending(userId, "order_t4x", 5);
  await seedPending(userId, "order_t4y", 7);

  const [rx, ry] = await Promise.all([
    creditTransactionOnce("order_t4x", { source: "s" }),
    creditTransactionOnce("order_t4y", { source: "s" }),
  ]);

  expect(rx.credited).toBe(true);
  expect(ry.credited).toBe(true);

  const user = await User.findById(userId).lean();
  expect(user!.walletBalance).toBe(12);

  // Both orders fire analytics independently
  expect(mockCapture).toHaveBeenCalledTimes(2);
});

// ---------------------------------------------------------------------------
// T5: Amount sourced from stored transaction, never from opts
// Failure mode caught: implementation accidentally uses an opts amount field
// or re-derives amount elsewhere instead of reading transaction.amount.
// ---------------------------------------------------------------------------
test("T5: credited amount equals stored transaction.amount regardless of opts contents", async () => {
  const userId = await seedUser(0);
  await seedPending(userId, "order_t5", 5);

  // opts includes a paymentId but no amount field — amount must come from DB
  const result = await creditTransactionOnce("order_t5", {
    source: "test",
    paymentId: "pay_INJECTED_999",
  });

  expect(result.credited).toBe(true);
  // amount in the return value must reflect the stored 5, not some derived value
  expect(result.amount).toBe(5);

  const user = await User.findById(userId).lean();
  expect(user!.walletBalance).toBe(5);
});

// ---------------------------------------------------------------------------
// T6: Transaction document state after a successful credit
// Failure mode caught: wallet balance updated but transaction flags not set
// (or set on wrong document).
// ---------------------------------------------------------------------------
test("T6: after credit, transaction.status=completed and metadata.walletCredited=true", async () => {
  const userId = await seedUser(0);
  const txn = await Transaction.create({
    userId,
    type: "credit",
    amount: 5,
    description: "top-up",
    razorpayOrderId: "order_t6",
    status: "pending",
    metadata: { walletCredited: false },
  });

  const result = await creditTransactionOnce("order_t6", { source: "s" });
  expect(result.credited).toBe(true);

  const reloaded = await Transaction.findById(txn._id).lean();
  expect(reloaded!.status).toBe("completed");
  expect(reloaded!.metadata!.walletCredited).toBe(true);
});

// ---------------------------------------------------------------------------
// T7: Pre-seeded already-credited transaction must never re-credit
// Failure mode caught: guard only checks status field, ignoring walletCredited;
// or guard only checks walletCredited, ignoring status — either gap re-credits.
// ---------------------------------------------------------------------------
test("T7: transaction pre-seeded as walletCredited=true is never credited again", async () => {
  const userId = await seedUser(0); // balance 0: the prior credit already happened in a past session

  // Simulate a transaction whose credit was already applied
  await Transaction.create({
    userId,
    type: "credit",
    amount: 5,
    description: "top-up",
    razorpayOrderId: "order_t7",
    status: "completed",
    metadata: { walletCredited: true },
  });

  const result = await creditTransactionOnce("order_t7", { source: "s" });
  expect(result.credited).toBe(false);

  const user = await User.findById(userId).lean();
  expect(user!.walletBalance).toBe(0); // untouched

  expect(mockCapture).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// T8: Return shape on successful credit includes userId and newBalance
// Failure mode caught: destructuring undefined fields silently returns wrong values.
// ---------------------------------------------------------------------------
test("T8: successful credit returns userId, amount, and newBalance in result", async () => {
  const userId = await seedUser(0);
  await seedPending(userId, "order_t8", 5);

  const result = await creditTransactionOnce("order_t8", { source: "s" });
  expect(result.credited).toBe(true);
  expect(result.userId?.toString()).toBe(userId.toString());
  expect(result.amount).toBe(5);
  expect(result.newBalance).toBe(5);
});

// ---------------------------------------------------------------------------
// T9: Concurrent calls on two separate orders for two separate users
// Failure mode caught: userId lookup collision or shared lock across users.
// ---------------------------------------------------------------------------
test("T9: concurrent credits for different users/orders do not interfere", async () => {
  const userId1 = await seedUser(0);
  const userId2 = await seedUser(0);
  await seedPending(userId1, "order_t9a", 3);
  await seedPending(userId2, "order_t9b", 8);

  const [r1, r2] = await Promise.all([
    creditTransactionOnce("order_t9a", { source: "s" }),
    creditTransactionOnce("order_t9b", { source: "s" }),
  ]);

  expect(r1.credited).toBe(true);
  expect(r2.credited).toBe(true);

  const u1 = await User.findById(userId1).lean();
  const u2 = await User.findById(userId2).lean();
  expect(u1!.walletBalance).toBe(3);
  expect(u2!.walletBalance).toBe(8);

  expect(mockCapture).toHaveBeenCalledTimes(2);
});

/*
 * DISCLOSURE
 * ----------
 * Files read during test authorship:
 *   - src/models/Transaction.ts  — schema field names (razorpayOrderId, metadata,
 *     status, amount, userId, type, description) and status enum values
 *     ("pending", "completed", "failed"). No logic was read.
 *   - src/models/User.ts          — walletBalance field name and its `min: 0`
 *     constraint. No logic was read.
 *   - src/services/analyticsService.ts — grep output only: confirmed the export
 *     name `captureLifecycleEvent` (line 125) and that `LifecycleEvent` is a
 *     union type with "wallet_topup_completed" as a member (lines 3-4). The
 *     function body and argument types were NOT read.
 *   - src/__tests__/setup.ts      — jest global setup (MongoMemoryServer connect,
 *     afterEach collection clear). No test strategy was read.
 *
 * Files explicitly NOT read per adversarial brief:
 *   - src/utils/creditWallet.ts
 *   - src/controllers/walletController.ts
 *   - src/__tests__/creditWallet.smoke.test.ts
 *   - src/__tests__/wallet.test.ts
 *   - All other test files in src/__tests__/
 *
 * How implementation details were avoided in assertions:
 *   - captureLifecycleEvent argument shape is unknown; only toHaveBeenCalledTimes
 *     is asserted, not the argument structure. The event name "wallet_topup_completed"
 *     is from the public contract spec, not from reading the implementation.
 *   - The balance assertion (toBe(5) not toBe(10)) derives from the contract
 *     guarantee ("credits the matching Transaction's owner wallet EXACTLY ONCE"),
 *     not from observing actual output.
 *   - T8 return-shape fields (userId, amount, newBalance) are from the contract
 *     signature; their exact types were not inferred from implementation code.
 */
