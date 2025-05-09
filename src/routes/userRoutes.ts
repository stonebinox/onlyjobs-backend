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
  setAudioAnswer,
  getAnsweredQuestions,
  setSkippedQuestion,
  createAnswer,
  getUserProfile,
  updateUserEmailAddress,
  updatePassword,
  updateMinMatchScore,
  factoryResetUserAccount,
  deleteUserAccount,
} from "../controllers/userController";

import { protect } from "../middleware/authMiddleware";
import upload from "../middleware/fileUpload";
import audioUpload from "../middleware/audioUpload";

const router = express.Router();

// Public routes
router.post("/auth", authenticateUser);

// Protected routes
router.get("/username", protect, getUserName);
router.get("/active-count", protect, getActiveUserCount);
router.put("/profile", protect, updateUserProfile);
router.get("/profile", protect, getUserProfile);
router.post("/cv", protect, upload.single("file"), updateUserCV);
router.get("/question", protect, getQuestion);
router.post("/answer", protect, setUserAnswer);
router.post(
  "/answer-audio",
  protect,
  audioUpload.single("file"),
  setAudioAnswer
);
router.get("/answers", protect, getAnsweredQuestions);
router.post("/skip-question", protect, setSkippedQuestion);
router.post("/create-answer", protect, createAnswer);
router.put("/update-email", protect, updateUserEmailAddress);
router.put("/password", protect, updatePassword);
router.put("/update-mini-score", protect, updateMinMatchScore);
router.post("/factory-reset", protect, factoryResetUserAccount);
router.delete("/delete", protect, deleteUserAccount);

// Unused routes
router.post("/skip/:jobId", protect, skipJob);

export default router;
