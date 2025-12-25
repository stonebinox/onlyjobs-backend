import { Request, Response } from "express";
import asyncHandler from "express-async-handler";

import JobListing from "../models/JobListing";

// @desc    Get the count of available job listings
// @route   GET /api/jobs/available-count
// @access  Public
export const getAvailableJobCount = asyncHandler(
  async (req: Request, res: Response) => {
    // Find count of job listings that have been fetched in the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const jobCount = await JobListing.countDocuments({
      postedDate: { $gte: thirtyDaysAgo },
    });

    res.json({ count: jobCount });
  }
);
