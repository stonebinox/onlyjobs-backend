import express from "express";
import { protect } from "../middleware/authMiddleware";
import {
  getAvailableJobCount,
  getPublicStats,
  getAllJobs,
  matchJobOnDemand,
} from "../controllers/jobController";

const router = express.Router();

// Public routes
router.get("/available-count", getAvailableJobCount);
router.get("/stats", getPublicStats);

// Authenticated routes
router.get("/", protect, getAllJobs);
router.post("/:jobId/match", protect, matchJobOnDemand);

export default router;
