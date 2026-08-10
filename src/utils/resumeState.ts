import { Types } from "mongoose";
import User from "../models/User";

export const resetNoResumeReminderState = async (userId: Types.ObjectId | string): Promise<void> => {
  await User.updateOne(
    { _id: userId },
    { $set: { noResumeReminderCount: 0 }, $unset: { lastNoResumeReminderAt: "" } }
  );
};
