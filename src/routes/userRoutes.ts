import express from "express";
import {
  authenticateUser,
  getUserName,
  getActiveUserCount,
  updateUserCV,
  updateUserProfile,
  skipJob,
  getMatches,
} from "../controllers/userController";

import upload from "../middlewares/fileUpload";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

// Public routes
router.post("/auth", authenticateUser);

// Protected routes
router.get("/username", protect, getUserName);
router.get("/active-count", protect, getActiveUserCount);
router.put("/profile", protect, updateUserProfile);
router.post("/cv", protect, upload.single("file"), updateUserCV);
router.post("/skip/:jobId", protect, skipJob);
router.get("/matches", protect, getMatches);

export default router;
