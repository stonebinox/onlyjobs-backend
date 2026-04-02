import { Request, Response } from "express";
import expressAsyncHandler from "express-async-handler";

import { processMessage, checkRateLimit } from "../services/chatService";
import ChatConversation from "../models/ChatConversation";
import ChatMemory from "../models/ChatMemory";

// @desc    Send a message to the AI chat
// @route   POST /api/chat/
// @access  Private
export const sendMessage = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;
    const { message, conversationId } = req.body;

    if (!message || typeof message !== "string" || message.trim() === "") {
      res.status(400);
      throw new Error("Message must be a non-empty string");
    }

    try {
      const withinLimit = await checkRateLimit(userId);
      if (!withinLimit) {
        res.status(429).json({ error: "Rate limit exceeded. Maximum 20 messages per hour." });
        return;
      }

      const result = await processMessage(userId, message, conversationId);

      res.json({ reply: result.reply, conversationId: result.conversationId });
    } catch (error: any) {
      const message = error?.message || 'Chat processing failed';
      if (message === 'Conversation not found') {
        return res.status(404).json({ error: message });
      } else {
        return res.status(500).json({ error: message });
      }
    }
  }
);

// @desc    Get user's conversations
// @route   GET /api/chat/conversations
// @access  Private
export const getConversations = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;

    const conversations = await ChatConversation.find({ userId })
      .select("title createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .limit(50);

    res.json(conversations);
  }
);

// @desc    Get a single conversation
// @route   GET /api/chat/conversations/:id
// @access  Private
export const getConversation = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;
    const conversationId = req.params.id;

    const conversation = await ChatConversation.findOne({ _id: conversationId, userId });

    if (!conversation) {
      res.status(404);
      throw new Error("Conversation not found");
    }

    res.json(conversation);
  }
);

// @desc    Get user's chat memory
// @route   GET /api/chat/memory
// @access  Private
export const getMemory = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;

    const memory = await ChatMemory.findOne({ userId });

    res.json(memory?.entries ?? []);
  }
);

// @desc    Delete user's chat memory
// @route   DELETE /api/chat/memory
// @access  Private
export const deleteMemory = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;

    await ChatMemory.deleteOne({ userId });

    res.json({ deleted: true });
  }
);
