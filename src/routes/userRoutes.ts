import express from "express";
import { protect } from "../middleware/authMiddleware";
import {
  updateUserProfile,
  uploadResume,
  skipJob,
  getMatches,
  authenticateUser,
  getUserName,
} from "../controllers/userController";

const router = express.Router();

// Public routes+
router.post("/authenticate", authenticateUser);

// Protected routes
router.get("/username", protect, getUserName);
router.put("/user", protect, updateUserProfile);
router.post("/resume", protect, uploadResume);
router.post("/skip/:jobId", protect, skipJob);
router.get("/matches", protect, getMatches);

export default router;
