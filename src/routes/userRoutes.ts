import express from "express";
import { protect } from "../middleware/authMiddleware";
import {
  registerUser,
  loginUser,
  getUserProfile,
  updateUserProfile,
  uploadResume,
  skipJob,
  getMatches,
} from "../controllers/userController";

const router = express.Router();

// Public routes
router.post("/register", registerUser);
router.post("/login", loginUser);

// Protected routes
router.get("/profile", protect, getUserProfile);
router.put("/profile", protect, updateUserProfile);
router.post("/resume", protect, uploadResume);
router.post("/skip/:jobId", protect, skipJob);
router.get("/matches", protect, getMatches);

export default router;
