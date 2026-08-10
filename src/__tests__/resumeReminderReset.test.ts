import { resetNoResumeReminderState } from "../utils/resumeState";

jest.mock("../models/User", () => ({
  __esModule: true,
  default: {
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
}));

import UserModel from "../models/User";

const MockUser = UserModel as jest.Mocked<typeof UserModel>;

describe("resetNoResumeReminderState", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("calls updateOne with correct reset fields", async () => {
    await resetNoResumeReminderState("user123");

    expect(MockUser.updateOne).toHaveBeenCalledWith(
      { _id: "user123" },
      { $set: { noResumeReminderCount: 0 }, $unset: { lastNoResumeReminderAt: "" } }
    );
  });

  test("works with ObjectId type", async () => {
    const { Types } = await import("mongoose");
    const objectId = new Types.ObjectId();
    await resetNoResumeReminderState(objectId);

    expect(MockUser.updateOne).toHaveBeenCalledWith(
      { _id: objectId },
      { $set: { noResumeReminderCount: 0 }, $unset: { lastNoResumeReminderAt: "" } }
    );
  });
});
