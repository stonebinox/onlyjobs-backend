import { Request, Response } from "express";
import expressAsyncHandler from "express-async-handler";

import MatchRecord from "../models/MatchRecord";
import User from "../models/User";
import JobListing from "../models/JobListing";
import {
  getMatchesData,
  markMatchAsClicked,
  skipMatch,
  markMatchAppliedStatus,
} from "../services/matchingService";
import { analyzeRejectionAndUpdatePreferences } from "../services/preferenceLearningService";

// @desc    Get user's job matches
// @route   GET /api/matches/
// @access  Private
export const getMatches = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;
    const { minMatchScore } = req.query;
    let minScore = 0;

    if (!minMatchScore) {
      minScore = 0;
    } else {
      minScore = parseInt(minMatchScore as string, 10);
    }

    const matches = await getMatchesData(userId, minScore);

    res.json(matches);
  }
);

// @desc    Get user's match count
// @route   GET /api/matches/count
// @access  Private
export const getMatchCount = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const matchCount = await MatchRecord.countDocuments({
      userId,
      createdAt: { $gte: thirtyDaysAgo },
      skipped: false,
    });

    if (matchCount === null) {
      res.status(404);
      throw new Error("No matches found");
    }

    res.json({ matchCount });
  }
);

// @desc    Mark a match as clicked
// @route   POST /api/matches/click
// @access  Private
export const markMatchClick = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const { matchId } = req.body;

    if (!matchId) {
      res.status(400);
      throw new Error("Match ID is required");
    }

    await markMatchAsClicked(matchId);

    res.json({ message: "Match marked as clicked" });
  }
);

export const markMatchAsSkipped = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const { matchId, reason, details } = req.body;

    if (!matchId) {
      res.status(400);
      throw new Error("Match ID is required");
    }

    // Build reason object if provided
    const reasonObj = reason ? { category: reason, details } : undefined;

    // Update the match record
    const match = await skipMatch(matchId, reasonObj);

    // If a reason was provided, trigger preference learning
    if (reasonObj) {
      try {
        const user = await User.findById(match.userId);
        const job = await JobListing.findById(match.jobId);

        if (user && job) {
          // Run preference learning (real-time)
          const result = await analyzeRejectionAndUpdatePreferences(
            user,
            job,
            match,
            reasonObj
          );

          // Update the match record to mark when it was analyzed
          if (result) {
            match.skipReason = {
              ...match.skipReason!,
              analyzedAt: new Date(),
            };
            await match.save();
          }
        }
      } catch (error) {
        // Log but don't fail the request if learning fails
        console.error("Error during preference learning (skip):", error);
      }
    }

    res.json({ message: "Match marked as skipped" });
  }
);

// @desc    Mark a match as applied or not applied
// @route   POST /api/matches/applied
// @access  Private
export const markMatchApplied = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const { matchId, applied, reason, details } = req.body;

    if (!matchId) {
      res.status(400);
      throw new Error("Match ID is required");
    }

    if (typeof applied !== "boolean") {
      res.status(400);
      throw new Error("Applied status must be a boolean");
    }

    // Build reason object if provided
    const reasonObj =
      !applied && reason ? { category: reason, details } : undefined;

    // Update the match record
    const match = await markMatchAppliedStatus(matchId, applied, reasonObj);

    // If user said "No" with a reason, trigger preference learning
    if (!applied && reasonObj) {
      try {
        const user = await User.findById(match.userId);
        const job = await JobListing.findById(match.jobId);

        if (user && job) {
          // Run preference learning (real-time as per plan)
          const result = await analyzeRejectionAndUpdatePreferences(
            user,
            job,
            match,
            reasonObj
          );

          // Update the match record to mark when it was analyzed
          if (result) {
            match.notAppliedReason = {
              ...match.notAppliedReason!,
              analyzedAt: new Date(),
            };
            await match.save();
          }
        }
      } catch (error) {
        // Log but don't fail the request if learning fails
        console.error("Error during preference learning:", error);
      }
    }

    res.json({ message: "Match applied status updated" });
  }
);
