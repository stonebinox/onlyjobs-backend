import { Request, Response } from "express";
import expressAsyncHandler from "express-async-handler";
import MatchRecord from "../models/MatchRecord";

// @desc    Get user's job matches
// @route   GET /api/matches/
// @access  Private
export const getMatches = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;

    // Fetch matches from the database (this is a placeholder, replace with actual DB call)
    const matches = await MatchRecord.find({ userId });

    if (!matches) {
      res.status(404);
      throw new Error("No matches found");
    }

    res.json(matches);
  }
);

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
