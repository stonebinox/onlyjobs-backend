import mongoose from "mongoose";
import MatchRecord from "../models/MatchRecord";
import JobListing from "../models/JobListing";

const BRIEF_WINDOW_DAYS = 15;
const DEFAULT_MIN_SCORE = 30;

// Mirrors the /today display predicate (frontend utils/today-selection.ts + GET /matches):
// created in the last 15 days, matchScore >= the user's resolved minScore (default 30),
// job still exists, and not skipped / clicked / answered (applied neither true nor false).
// Existence check only: never triggers matching or scoring.
export async function hasVisibleBriefMatch(
  userId: mongoose.Types.ObjectId | string,
  minScore: number | undefined | null,
  now: Date = new Date()
): Promise<boolean> {
  // Same window as getMatchesData: createdAt >= (now - 15 calendar days), inclusive.
  const since = new Date(now.getTime());
  since.setDate(since.getDate() - BRIEF_WINDOW_DAYS);

  const candidates = await MatchRecord.find({
    userId,
    createdAt: { $gte: since },
    matchScore: { $gte: minScore ?? DEFAULT_MIN_SCORE },
    skipped: { $ne: true },
    clicked: { $ne: true },
    applied: null,
  }).select("jobId");

  if (candidates.length === 0) return false;

  const job = await JobListing.exists({ _id: { $in: candidates.map((m) => m.jobId) } });
  return job !== null;
}
