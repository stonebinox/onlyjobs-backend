import express from "express";

import { protect } from "../middleware/authMiddleware";
import {
  getMatchCount,
  getMatches,
  getSkipped,
  getTracker,
  markMatchAsSkipped,
  markMatchClick,
  markMatchApplied,
  recordApplicationOutcome,
  triggerMatchForMe,
  unskipMatch,
} from "../controllers/matchController";
import { getOutOfCreditPreview } from "../controllers/outOfCreditPreviewController";

const router = express.Router();

router.get("/out-of-credit-preview", protect, getOutOfCreditPreview);
router.get("/tracker", protect, getTracker);
router.get("/", protect, getMatches);
router.get("/count", protect, getMatchCount);
router.post("/click", protect, markMatchClick);
router.post("/skip", protect, markMatchAsSkipped);
router.post("/applied", protect, markMatchApplied);
router.get("/skipped", protect, getSkipped);
router.post("/unskip", protect, unskipMatch);
router.post("/trigger-for-me", protect, triggerMatchForMe);
router.post("/:id/outcome", protect, recordApplicationOutcome);

export default router;
