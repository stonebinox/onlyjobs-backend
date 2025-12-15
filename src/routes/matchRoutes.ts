import express from "express";

import { protect } from "../middleware/authMiddleware";
import {
  getMatchCount,
  getMatches,
  markMatchAsSkipped,
  markMatchClick,
  markMatchApplied,
} from "../controllers/matchController";

const router = express.Router();

router.get("/", protect, getMatches);
router.get("/count", protect, getMatchCount);
router.post("/click", protect, markMatchClick);
router.post("/skip", protect, markMatchAsSkipped);
router.post("/applied", protect, markMatchApplied);

export default router;
