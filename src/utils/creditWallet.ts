import { Types } from "mongoose";
import Transaction from "../models/Transaction";
import User from "../models/User";
import { captureLifecycleEvent } from "../services/analyticsService";
import { enqueuePurchase, purchaseClientFields } from "./metaEvents";

interface CreditResult {
  credited: boolean;
  userId?: Types.ObjectId;
  amount?: number;
  newBalance?: number;
  // Present only when the transaction is completed AND walletCredited === true
  // (for the winner and for a caller that lost the race).
  metaEventId?: string;
  value?: number;
  currency?: string;
}

export async function creditTransactionOnce(
  orderId: string,
  opts: { paymentId?: string; source: string }
): Promise<CreditResult> {
  const setFields: Record<string, unknown> = {
    status: "completed",
    "metadata.walletCredited": true,
    "metadata.walletCreditedAt": new Date(),
    "metadata.creditedBy": opts.source,
  };
  if (opts.paymentId) {
    setFields.razorpayPaymentId = opts.paymentId;
    setFields["metadata.paymentId"] = opts.paymentId;
  }

  const claimed = await Transaction.findOneAndUpdate(
    { razorpayOrderId: orderId, status: { $ne: "completed" }, "metadata.walletCredited": { $ne: true } },
    { $set: setFields },
    { new: true }
  );
  if (!claimed) {
    try {
      const existing = await Transaction.findOne({ razorpayOrderId: orderId });
      return { credited: false, ...(existing ? purchaseClientFields(existing) : {}) };
    } catch {
      return { credited: false };
    }
  }

  await User.updateOne({ _id: claimed.userId }, { $inc: { walletBalance: claimed.amount } });

  const user = await User.findById(claimed.userId);
  if (user) captureLifecycleEvent(user, "wallet_topup_completed");
  await enqueuePurchase(claimed, user ?? {});

  return {
    credited: true,
    userId: claimed.userId as Types.ObjectId,
    amount: claimed.amount,
    newBalance: user?.walletBalance,
    ...purchaseClientFields(claimed),
  };
}
