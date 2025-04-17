import express from "express";

import { protect } from "../middleware/authMiddleware";
import { getMatches } from "../controllers/matchController";

const router = express.Router();

router.get("/", protect, getMatches);

export default router;
