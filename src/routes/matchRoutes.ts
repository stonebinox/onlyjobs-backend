import express from "express";

import { protect } from "../middleware/authMiddleware";
import { getMatchCount, getMatches } from "../controllers/matchController";

const router = express.Router();

router.get("/", protect, getMatches);
router.get("/count", protect, getMatchCount);

export default router;
