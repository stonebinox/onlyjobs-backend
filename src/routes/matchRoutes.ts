import express from "express";

import { protect } from "../middleware/authMiddleware";
import {
  getMatchCount,
  getMatches,
  markMatchClick,
} from "../controllers/matchController";

const router = express.Router();

router.get("/", protect, getMatches);
router.get("/count", protect, getMatchCount);
router.post("/click", protect, markMatchClick);

export default router;
