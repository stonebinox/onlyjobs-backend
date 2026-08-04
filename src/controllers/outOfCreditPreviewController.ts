import expressAsyncHandler from "express-async-handler";
import { Request, Response } from "express";
import mongoose from "mongoose";
import JobListing from "../models/JobListing";
import MatchRecord from "../models/MatchRecord";
import User from "../models/User";
import { applyPreferenceFilters } from "../utils/preferenceFilters";
import { hasMeaningfulResume } from "../utils/resumePredicate";

const DAILY_MATCH_COST = 0.3;
const ON_DEMAND_MATCH_COST = 0.05;

function sendEmpty(res: Response, reason: string, walletBalance: number): void {
  res.json({
    shouldShow: false,
    reason,
    walletBalance,
    dailyMatchCost: DAILY_MATCH_COST,
    onDemandMatchCost: ON_DEMAND_MATCH_COST,
    count: 0,
    candidates: [],
  });
}

export const getOutOfCreditPreview = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user._id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    const balance = user.walletBalance ?? 0;

    if (!user.isVerified) {
      sendEmpty(res, "unverified", balance);
      return;
    }

    if (!hasMeaningfulResume(user.resume)) {
      sendEmpty(res, "no_resume", balance);
      return;
    }

    const matchingEnabled = user.preferences?.matchingEnabled;
    const disabledReason = user.matchingDisabledReason;

    // Suppress only when disabled for a reason other than auto_low_balance.
    // Missing/null reason: treat as user-disabled — they disabled before the field
    // existed, and telling them "add funds" when they intentionally paused is the
    // worse error.
    if (matchingEnabled === false && disabledReason !== "auto_low_balance") {
      sendEmpty(res, "user_disabled", balance);
      return;
    }

    if (balance >= DAILY_MATCH_COST) {
      sendEmpty(res, "sufficient_balance", balance);
      return;
    }

    // shouldShow: true — auto_low_balance + balance < 0.30
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

    const recentJobs = await JobListing.find({
      postedDate: { $gte: fifteenDaysAgo },
    });

    const prefFiltered = applyPreferenceFilters(
      recentJobs,
      user.preferences ?? {}
    );

    const existingMatchIds = new Set(
      (
        await MatchRecord.find({ userId: user._id }, { jobId: 1 })
      ).map((m) => (m.jobId as mongoose.Types.ObjectId).toString())
    );

    const skippedJobIds = new Set(
      (user.skippedJobs || []).map((id) => (id as mongoose.Types.ObjectId).toString())
    );

    const eligible = prefFiltered.kept.filter(
      (job) =>
        !existingMatchIds.has((job._id as mongoose.Types.ObjectId).toString()) &&
        !skippedJobIds.has((job._id as mongoose.Types.ObjectId).toString())
    );

    const count = eligible.length;
    const candidates = eligible.slice(0, 5).map((job) => ({
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      postedDate: job.postedDate,
    }));

    res.json({
      shouldShow: true,
      reason: "auto_low_balance",
      walletBalance: balance,
      dailyMatchCost: DAILY_MATCH_COST,
      onDemandMatchCost: ON_DEMAND_MATCH_COST,
      count,
      candidates,
    });
  }
);
