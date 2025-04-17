import { Request, Response } from "express";
import expressAsyncHandler from "express-async-handler";

// @desc    Get user's job matches
// @route   GET /api/matches/
// @access  Private
export const getMatches = expressAsyncHandler(
  async (req: Request, res: Response) => {}
);
