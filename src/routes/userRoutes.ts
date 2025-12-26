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
  getMatchQnAHistory,
  getUserProfile,
  updateUserEmailAddress,
  updatePassword,
  updateMinMatchScore,
  factoryResetUserAccount,
  deleteUserAccount,
  searchSkills,
  updatePreferences,
  requestEmailChange,
  verifyEmailChange,
  resendVerificationEmail,
  verifyInitialEmail,
  getGuideProgress,
  updateGuideProgress,
  resetGuideProgress,
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
router.get("/skills/search", protect, searchSkills);
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
router.get("/match-qna/:matchRecordId", protect, getMatchQnAHistory);
router.put("/update-email", protect, updateUserEmailAddress);
router.post("/email-change/request", protect, requestEmailChange);
router.post("/email-change/verify", verifyEmailChange);
router.post("/resend-verification", protect, resendVerificationEmail);
router.post("/verify-email", verifyInitialEmail);
router.put("/password", protect, updatePassword);
router.put("/update-mini-score", protect, updateMinMatchScore);
router.put("/preferences", protect, updatePreferences);
router.post("/factory-reset", protect, factoryResetUserAccount);
router.delete("/delete", protect, deleteUserAccount);
router.get("/guide-progress", protect, getGuideProgress);
router.put("/guide-progress", protect, updateGuideProgress);
router.post("/guide-progress/reset", protect, resetGuideProgress);

// Unused routes
router.post("/skip/:jobId", protect, skipJob);

export default router;
