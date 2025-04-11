import express from "express";

import { protect } from "../middleware/authMiddleware";
import {
  getJobs,
  getJobById,
  trackJobClick,
  searchJobs,
} from "../controllers/jobController";

const router = express.Router();

// Protected routes
router.get("/", protect, getJobs);
router.get("/search", protect, searchJobs);
router.get("/:id", protect, getJobById);
router.post("/:id/click", protect, trackJobClick);

export default router;
