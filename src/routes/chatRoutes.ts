import express from "express";

import { protect } from "../middleware/authMiddleware";
import {
  sendMessage,
  getConversations,
  getConversation,
  getMemory,
  deleteMemory,
  upsertJobConversation,
} from "../controllers/chatController";

const router = express.Router();

router.post("/", protect, sendMessage);
router.post("/conversations", protect, upsertJobConversation);
router.get("/conversations", protect, getConversations);
router.get("/conversations/:id", protect, getConversation);
router.get("/memory", protect, getMemory);
router.delete("/memory", protect, deleteMemory);

export default router;
