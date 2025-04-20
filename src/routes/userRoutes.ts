import express from "express";
import {
  authenticateUser,
  getUserName,
  getActiveUserCount,
  updateUserCV,
  updateUserProfile,
  skipJob,
  getQuestion,
  setUserAnswer,
} from "../controllers/userController";

import { protect } from "../middleware/authMiddleware";
import upload from "../middleware/fileUpload";

const router = express.Router();

// Public routes
router.post("/auth", authenticateUser);

// Protected routes
router.get("/username", protect, getUserName);
router.get("/active-count", protect, getActiveUserCount);
router.put("/profile", protect, updateUserProfile);
router.post("/cv", protect, upload.single("file"), updateUserCV);
router.post("/skip/:jobId", protect, skipJob);
router.get("/question", protect, getQuestion);
router.post("/answer", protect, setUserAnswer);

export default router;
