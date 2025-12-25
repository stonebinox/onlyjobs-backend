import express from "express";

import { getAvailableJobCount } from "../controllers/jobController";

const router = express.Router();

// Public route - used on landing page to show job count
router.get("/available-count", getAvailableJobCount);

export default router;
