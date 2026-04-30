import express from "express";

import { getAvailableJobCount, getPublicStats } from "../controllers/jobController";

const router = express.Router();

// Public routes - used on landing page
router.get("/available-count", getAvailableJobCount);
router.get("/stats", getPublicStats);

export default router;
