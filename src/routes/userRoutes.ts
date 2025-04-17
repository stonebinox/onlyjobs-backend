import express from "express";

import { protect } from "../middleware/authMiddleware";
import {
  updateUserProfile,
  uploadResume,
  skipJob,
  getMatches,
  authenticateUser,
  getUserName,
  getActiveUserCount,
} from "../controllers/userController";

const router = express.Router();

// Public routes+
router.post("/authenticate", authenticateUser);

// Protected routes
router.get("/username", protect, getUserName);
router.get("/active-count", protect, getActiveUserCount);
router.put("/user", protect, updateUserProfile);
router.post("/resume", protect, uploadResume);
router.post("/skip/:jobId", protect, skipJob);
router.get("/matches", protect, getMatches);

export default router;
