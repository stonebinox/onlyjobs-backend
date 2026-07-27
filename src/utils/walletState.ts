import { Types } from "mongoose";
import User from "../models/User";

export const reconcilePostCreditWalletState = async (userId: Types.ObjectId | string): Promise<void> => {
  await User.updateOne(
    { _id: userId, walletBalance: { $gte: 0.3 } },
    { $set: { balanceReminderCount: 0 }, $unset: { lastBalanceReminderAt: "" } }
  );
  await User.updateOne(
    {
      _id: userId,
      walletBalance: { $gte: 0.3 },
      "preferences.matchingEnabled": false,
      matchingDisabledReason: "auto_low_balance",
    },
    { $set: { "preferences.matchingEnabled": true }, $unset: { matchingDisabledReason: "" } }
  );
};
