import { Request, Response } from "express";
import asyncHandler from "express-async-handler";

import JobListing from "../models/JobListing";
import User from "../models/User";

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
