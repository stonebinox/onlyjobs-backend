import express from "express";

import { runDailyJobScraping } from "../jobs/scrapeJobs";
import runDailyJobMatching from "../jobs/matchJobs";
import User from "../models/User";
import { sendMatchSummaryEmail } from "../services/emailService";
import { Freshness } from "../models/MatchRecord";

const router = express.Router();

// Protected dev-only route to trigger scraping manually
router.post("/test-scrape", async (req, res) => {
  try {
    await runDailyJobScraping();
    res.status(200).json({ message: "Scrape job run successfully" });
  } catch (err) {
    console.error("Error in /test-scrape route:", err);
    res.status(500).json({ message: "Scrape job failed", error: err });
  }
});

router.post("/test-match", async (req, res) => {
  try {
    if (req.body?.email) {
      const { email } = req.body;

      const user = await User.findOne({ email });

      if (!user) {
        res.status(404).json({ message: "User not found" });

        return;
      }

      // Match jobs for a specific user if email is provided
      await runDailyJobMatching(user.id);
      res
        .status(200)
        .json({ message: `Match job run successfully for user: ${email}` });
    } else {
      // Run for all users if no email is provided
      await runDailyJobMatching();
      res
        .status(200)
        .json({ message: "Match job run successfully for all users" });
    }
  } catch (err) {
    console.error("Error in /test-match route:", err);
    res.status(500).json({ message: "Match job failed", error: err });
  }
});

// Test route to send a sample match summary email
router.post("/test-email", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ message: "Email is required" });
      return;
    }

    const user = await User.findOne({ email });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    // Create sample match data for testing
    const sampleMatches = [
      {
        title: "Senior Software Engineer",
        company: "Tech Corp",
        url: "https://example.com/job/1",
        matchScore: 85,
        freshness: Freshness.FRESH,
      },
      {
        title: "Full Stack Developer",
        company: "StartupXYZ",
        url: "https://example.com/job/2",
        matchScore: 78,
        freshness: Freshness.FRESH,
      },
      {
        title: "Backend Engineer",
        company: "Cloud Services Inc",
        url: "https://example.com/job/3",
        matchScore: 72,
        freshness: Freshness.WARM,
      },
    ];

    console.log(`[TEST] Sending test email to ${email}`);
    const emailSent = await sendMatchSummaryEmail(user, sampleMatches, 0.3);

    if (emailSent) {
      res.status(200).json({
        message: `Test email sent successfully to ${email}`,
        matches: sampleMatches.length,
      });
    } else {
      res.status(500).json({
        message: `Failed to send test email to ${email}. Check server logs for details.`,
      });
    }
  } catch (err) {
    console.error("Error in /test-email route:", err);
    res.status(500).json({ message: "Test email failed", error: err });
  }
});

export default router;
