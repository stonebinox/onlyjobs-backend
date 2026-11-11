import MetaEventOutbox from "../models/MetaEventOutbox";
import Transaction from "../models/Transaction";
import User from "../models/User";
import {
  actEventId,
  enqueueActivated,
  enqueueCompleteRegistration,
  enqueuePurchase,
  getMetaCapiStartAt,
  purchaseEventId,
  regEventId,
} from "../utils/metaEvents";

// At-least-once enqueue with bounded reconciliation (NOT transactional): re-enqueues
// conversions whose outbox row is missing. 7 days is Meta's event_time limit.

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 500;

async function existingIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await MetaEventOutbox.find({ eventId: { $in: ids } }).select("eventId");
  return new Set(rows.map((r) => r.eventId));
}

export async function reconcileMetaEvents(): Promise<{ purchases: number; registrations: number; activations: number }> {
  const startAt = getMetaCapiStartAt();
  const result = { purchases: 0, registrations: 0, activations: 0 };
  if (!startAt) return result;
  const windowStart = new Date(Math.max(startAt.getTime(), Date.now() - WINDOW_MS));

  // Purchases: captured Razorpay top-ups only (never welcome bonus, debits, manual credits).
  const txns = await Transaction.find({
    type: "credit",
    razorpayOrderId: { $exists: true, $ne: null },
    "metadata.walletCredited": true,
    "metadata.type": { $ne: "welcome_bonus" },
    "metadata.walletCreditedAt": { $gte: windowStart },
  }).limit(SCAN_LIMIT);
  const havePurchase = await existingIds(txns.map((t) => purchaseEventId(t._id)));
  for (const txn of txns) {
    if (havePurchase.has(purchaseEventId(txn._id))) continue;
    const user = await User.findById(txn.userId);
    await enqueuePurchase(txn, user ?? {});
    result.purchases++;
  }

  const newUsers = await User.find({ createdAt: { $gte: windowStart } }).limit(SCAN_LIMIT);
  const haveReg = await existingIds(newUsers.map((u) => regEventId(u._id)));
  for (const user of newUsers) {
    if (haveReg.has(regEventId(user._id))) continue;
    await enqueueCompleteRegistration(user);
    result.registrations++;
  }

  const activated = await User.find({
    metaActivatedAt: { $gte: windowStart },
    createdAt: { $gte: startAt },
  }).limit(SCAN_LIMIT);
  const haveAct = await existingIds(activated.map((u) => actEventId(u._id)));
  for (const user of activated) {
    if (haveAct.has(actEventId(user._id)) || !user.metaActivatedAt) continue;
    await enqueueActivated(user, user.metaActivatedAt);
    result.activations++;
  }

  return result;
}
