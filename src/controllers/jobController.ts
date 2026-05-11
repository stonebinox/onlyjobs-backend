import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import mongoose from "mongoose";

import JobListing from "../models/JobListing";
import User from "../models/User";
import MatchRecord from "../models/MatchRecord";
import Transaction from "../models/Transaction";
import { matchUserToJob } from "../services/matchingService";

// @desc    Get the count of available job listings
// @route   GET /api/jobs/available-count
// @access  Public
export const getAvailableJobCount = asyncHandler(
  async (req: Request, res: Response) => {
    // Find count of job listings that have been fetched in the last 15 days
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

    const jobCount = await JobListing.countDocuments({
      postedDate: { $gte: fifteenDaysAgo },
    });

    res.json({ count: jobCount });
  }
);

// @desc    Get public landing page stats (job count + verified user count)
// @route   GET /api/jobs/stats
// @access  Public
export const getPublicStats = asyncHandler(
  async (req: Request, res: Response) => {
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

    const [jobCount, userCount] = await Promise.all([
      JobListing.countDocuments({ postedDate: { $gte: fifteenDaysAgo } }),
      User.countDocuments({ isVerified: true }),
    ]);

    res.json({ jobCount, userCount });
  }
);

function hasValidResume(user: any): boolean {
  return (
    (user.resume?.summary && user.resume.summary.trim().length > 0) ||
    (Array.isArray(user.resume?.skills) && user.resume.skills.length > 0) ||
    (Array.isArray(user.resume?.experience) && user.resume.experience.length > 0)
  );
}

// @desc    Browse full job pool with match hydration
// @route   GET /api/jobs
// @access  Private (verified users only)
export const getAllJobs = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;

  if (!user.isVerified) {
    res.status(403);
    throw new Error("Account not verified");
  }

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const source = req.query.source as string | undefined;
  const pageSize = 20;

  const fifteenDaysAgo = new Date();
  fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

  const filter: Record<string, any> = {
    postedDate: { $gte: fifteenDaysAgo },
    description: { $exists: true, $nin: ["", "-- No description available --"] },
  };
  if (source) filter.source = source;

  const [jobs, total, sources] = await Promise.all([
    JobListing.find(filter)
      .sort({ postedDate: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    JobListing.countDocuments(filter),
    JobListing.distinct("source", {
      postedDate: { $gte: fifteenDaysAgo },
      description: { $exists: true, $nin: ["", "-- No description available --"] },
    }),
  ]);

  const jobIds = jobs.map((j) => j._id);
  const matchRecords = await MatchRecord.find({
    userId: user._id,
    jobId: { $in: jobIds },
  }).lean();

  const matchMap = new Map(matchRecords.map((m) => [m.jobId.toString(), m]));

  const jobsWithMatch = jobs.map((job) => {
    const match = matchMap.get((job._id as mongoose.Types.ObjectId).toString());
    return {
      ...job,
      match: match
        ? {
            _id: match._id,
            matchScore: match.matchScore,
            verdict: match.verdict,
            reasoning: match.reasoning,
            skipped: match.skipped,
            applied: match.applied,
            updatedAt: match.updatedAt,
          }
        : null,
    };
  });

  res.json({
    jobs: jobsWithMatch,
    total,
    page,
    pages: Math.ceil(total / pageSize),
    sources: sources.sort(),
  });
});

const ON_DEMAND_MATCH_COST = 0.05;

// @desc    Run on-demand match analysis for a single job
// @route   POST /api/jobs/:jobId/match
// @access  Private
export const matchJobOnDemand = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { jobId } = req.params;

  if (!user.isVerified) {
    res.status(403);
    throw new Error("Account not verified");
  }

  if (!hasValidResume(user)) {
    res.status(400);
    throw new Error("Upload your CV first");
  }

  const balance = user.walletBalance || 0;
  if (balance < ON_DEMAND_MATCH_COST) {
    res.status(400);
    throw new Error("Insufficient balance");
  }

  const existing = await MatchRecord.findOne({ userId: user._id, jobId });
  if (existing) {
    res.status(400);
    throw new Error("Already matched");
  }

  const fifteenDaysAgo = new Date();
  fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
  const job = await JobListing.findOne({
    _id: jobId,
    postedDate: { $gte: fifteenDaysAgo },
  });
  if (!job) {
    res.status(404);
    throw new Error("Job not found or no longer available");
  }

  const matchResult = await matchUserToJob(user, job);

  // 1. Deduct wallet atomically
  const updated = await User.findOneAndUpdate(
    { _id: user._id, walletBalance: { $gte: ON_DEMAND_MATCH_COST } },
    { $inc: { walletBalance: -ON_DEMAND_MATCH_COST } },
    { new: true }
  );
  if (!updated) {
    res.status(400);
    throw new Error("Insufficient balance");
  }
  await User.updateOne(
    { _id: user._id },
    { $set: { walletBalance: Math.round(updated.walletBalance * 100) / 100 } }
  );

  // 2. Create MatchRecord — reverse wallet on duplicate key
  let matchRecord: any;
  try {
    matchRecord = await MatchRecord.create({
      userId: user._id,
      jobId: job._id,
      matchScore: matchResult.matchScore,
      verdict: matchResult.verdict,
      reasoning: matchResult.reasoning,
      freshness: matchResult.freshness,
      clicked: false,
      skipped: false,
      applied: null,
    });
  } catch (err: any) {
    // Always reverse wallet deduction on any MatchRecord failure
    await User.updateOne({ _id: user._id }, { $inc: { walletBalance: ON_DEMAND_MATCH_COST } });
    if (err.code === 11000) {
      res.status(400);
      throw new Error("Already matched");
    }
    throw err;
  }

  // 3. Create Transaction (audit log only — do not throw on failure)
  try {
    await Transaction.create({
      userId: user._id,
      type: "debit",
      amount: ON_DEMAND_MATCH_COST,
      description: `On-demand match: ${job.title} at ${job.company}`,
      status: "completed",
      timestamp: new Date(),
    });
  } catch (err) {
    console.error("Failed to create transaction record:", err);
  }

  res.json({
    success: true,
    match: {
      _id: matchRecord._id,
      matchScore: matchRecord.matchScore,
      verdict: matchRecord.verdict,
      reasoning: matchRecord.reasoning,
      skipped: matchRecord.skipped,
      applied: matchRecord.applied,
      updatedAt: matchRecord.updatedAt,
    },
  });
});
