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
    const userId = req.user!._id;
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
    const userId = req.user!._id;
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
    const matchCount = await MatchRecord.countDocuments({
      userId,
      createdAt: { $gte: fifteenDaysAgo },
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
    const userId = req.user!._id;

    if (!matchId) {
      res.status(400);
      throw new Error("Match ID is required");
    }

    const match = await MatchRecord.findById(matchId);
    if (!match) {
      res.status(404);
      throw new Error("Match not found");
    }
    if (match.userId.toString() !== userId.toString()) {
      res.status(403);
      throw new Error("Not authorized to update this match");
    }

    await markMatchAsClicked(matchId, userId);

    res.json({ message: "Match marked as clicked" });
  }
);

export const markMatchAsSkipped = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const { matchId, reason, details } = req.body;
    const userId = req.user!._id;

    if (!matchId) {
      res.status(400);
      throw new Error("Match ID is required");
    }

    // Build reason object if provided
    const reasonObj = reason ? { category: reason, details } : undefined;

    // Update the match record
    const existingMatch = await MatchRecord.findById(matchId);
    if (!existingMatch) {
      res.status(404);
      throw new Error("Match not found");
    }
    if (existingMatch.userId.toString() !== userId.toString()) {
      res.status(403);
      throw new Error("Not authorized to update this match");
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const match = (await skipMatch(matchId, userId, reasonObj))!;

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
    const userId = req.user!._id;

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
    const existingMatch = await MatchRecord.findById(matchId);
    if (!existingMatch) {
      res.status(404);
      throw new Error("Match not found");
    }
    if (existingMatch.userId.toString() !== userId.toString()) {
      res.status(403);
      throw new Error("Not authorized to update this match");
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const match = (await markMatchAppliedStatus(matchId, userId, applied, reasonObj))!;

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

// @desc    Record application outcome (heard back, rejected, etc.)
// @route   POST /api/matches/:id/outcome
// @access  Private
export const recordApplicationOutcome = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { outcome } = req.body;
    const userId = req.user!._id;

    const validOutcomes = ['heard_back', 'no_response', 'rejected', 'interview', 'offer'];
    if (!outcome || !validOutcomes.includes(outcome)) {
      res.status(400);
      throw new Error(`Invalid outcome. Must be one of: ${validOutcomes.join(', ')}`);
    }

    const match = await MatchRecord.findById(id);
    if (!match) {
      res.status(404);
      throw new Error("Match not found");
    }

    if (match.userId.toString() !== userId.toString()) {
      res.status(403);
      throw new Error("Not authorized to update this match");
    }

    if (match.applied !== true) {
      res.status(400);
      throw new Error("Can only record outcome for applied jobs");
    }

    match.applicationOutcome = outcome;
    match.outcomeRecordedAt = new Date();
    await match.save();

    res.json({ message: "Application outcome recorded", outcome });
  }
);

// @desc    Trigger on-demand job matching for the authenticated user
// @route   POST /api/matches/trigger-for-me
// @access  Private
export const triggerMatchForMe = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!._id.toString();
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    if (user.lastManualMatchAt && Date.now() - user.lastManualMatchAt.getTime() < SIX_HOURS_MS) {
      const retryAfterMinutes = Math.ceil(
        (user.lastManualMatchAt.getTime() + SIX_HOURS_MS - Date.now()) / 60000
      );
      res.status(429).json({
        message: `Please wait before triggering another match run.`,
        retryAfterMinutes,
      });
      return;
    }

    const backgroundUrl = process.env.BACKGROUND_SERVICE_URL || "http://localhost:5001";
    const secret = process.env.INTERNAL_TRIGGER_SECRET;

    if (!secret) {
      console.error("[TRIGGER] INTERNAL_TRIGGER_SECRET not configured");
      res.status(503).json({ message: "Matching service not configured" });
      return;
    }

    try {
      const response = await fetch(`${backgroundUrl}/internal/match-for-user`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": secret,
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[TRIGGER] Background service error: ${errText}`);
        res.status(502).json({ message: "Failed to start matching" });
        return;
      }
    } catch (fetchErr) {
      console.error("[TRIGGER] Could not reach background service:", fetchErr);
      res.status(502).json({ message: "Matching service unreachable" });
      return;
    }

    // Only update cooldown after confirmed dispatch
    await User.findByIdAndUpdate(userId, { lastManualMatchAt: new Date() });
    console.log(`[TRIGGER] Match run started for user ${userId}`);
    res.status(202).json({ message: "Match run started — results will appear in a few minutes" });
  }
);
