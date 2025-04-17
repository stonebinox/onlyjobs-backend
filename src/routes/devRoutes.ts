import express from "express";

import { runDailyJobScraping } from "../jobs/scrapeJobs";
import runDailyJobMatching from "../jobs/matchJobs";

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
    await runDailyJobMatching();
    res.status(200).json({ message: "Match job run successfully" });
  } catch (err) {
    console.error("Error in /test-match route:", err);
    res.status(500).json({ message: "Match job failed", error: err });
  }
});

export default router;
