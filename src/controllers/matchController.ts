import { Request, Response } from "express";
import expressAsyncHandler from "express-async-handler";
import MatchRecord from "../models/MatchRecord";
import { getMatchesData } from "../services/matchingService";

// @desc    Get user's job matches
// @route   GET /api/matches/
// @access  Private
export const getMatches = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;
    const matches = await getMatchesData(userId);

    res.json(matches);
  }
);

// @desc    Get user's match count
// @route   GET /api/matches/count
// @access  Private
export const getMatchCount = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;
    const matchCount = await MatchRecord.countDocuments({ userId });

    if (matchCount === null) {
      res.status(404);
      throw new Error("No matches found");
    }

    res.json({ matchCount });
  }
);
