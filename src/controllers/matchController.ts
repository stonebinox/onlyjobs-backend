import { Request, Response } from "express";
import expressAsyncHandler from "express-async-handler";

import MatchRecord from "../models/MatchRecord";
import {
  getMatchesData,
  markMatchAsClicked,
  skipMatch,
  markMatchAppliedStatus,
} from "../services/matchingService";

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
    const { matchId } = req.body;

    if (!matchId) {
      res.status(400);
      throw new Error("Match ID is required");
    }

    await skipMatch(matchId);

    res.json({ message: "Match marked as skipped" });
  }
);

// @desc    Mark a match as applied or not applied
// @route   POST /api/matches/applied
// @access  Private
export const markMatchApplied = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const { matchId, applied } = req.body;

    if (!matchId) {
      res.status(400);
      throw new Error("Match ID is required");
    }

    if (typeof applied !== "boolean") {
      res.status(400);
      throw new Error("Applied status must be a boolean");
    }

    await markMatchAppliedStatus(matchId, applied);

    res.json({ message: "Match applied status updated" });
  }
);
