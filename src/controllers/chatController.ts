import { Request, Response } from "express";
import expressAsyncHandler from "express-async-handler";
import mongoose from "mongoose";

import { processMessage, checkRateLimit } from "../services/chatService";
import ChatConversation from "../models/ChatConversation";
import ChatMemory from "../models/ChatMemory";
import MatchRecord from "../models/MatchRecord";

// @desc    Send a message to the AI chat
// @route   POST /api/chat/
// @access  Private
export const sendMessage = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!._id;
    const { message, conversationId } = req.body;

    if (!message || typeof message !== "string" || message.trim() === "") {
      res.status(400);
      throw new Error("Message must be a non-empty string");
    }

    try {
      const withinLimit = await checkRateLimit(userId);
      if (!withinLimit) {
        console.log('[Chat] Rate limit hit for user:', userId.toString());
        res.status(429).json({ error: "Rate limit exceeded. Maximum 50 messages per hour." });
        return;
      }

      const result = await processMessage(userId, message, conversationId);

      res.json({ reply: result.reply, conversationId: result.conversationId });
    } catch (error: any) {
      const errorMessage = error?.message || 'Chat processing failed';
      if (errorMessage === 'Conversation not found' || error?.statusCode === 404) {
        res.status(404).json({ error: errorMessage });
      } else {
        res.status(500).json({ error: errorMessage });
      }
      return;
    }
  }
);

// @desc    Get user's conversations
// @route   GET /api/chat/conversations
// @access  Private
export const getConversations = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!._id;

    const conversations = await ChatConversation.find({ userId, contextType: { $ne: "job" } })
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
    const userId = req.user!._id;
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
    const userId = req.user!._id;

    const memory = await ChatMemory.findOne({ userId });

    res.json(memory?.entries ?? []);
  }
);

// @desc    Delete user's chat memory
// @route   DELETE /api/chat/memory
// @access  Private
export const deleteMemory = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!._id;

    await ChatMemory.deleteOne({ userId });

    res.json({ deleted: true });
  }
);

// @desc    Find or create a per-job contextual conversation (one per match)
// @route   POST /api/chat/conversations
// @access  Private
export const upsertJobConversation = expressAsyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!._id;
    const { contextType, contextMatchId } = req.body;

    if (contextType !== "job") {
      res.status(400).json({ error: "contextType must be 'job'" });
      return;
    }

    if (!contextMatchId || !mongoose.Types.ObjectId.isValid(String(contextMatchId))) {
      res.status(400).json({ error: "contextMatchId must be a valid ObjectId" });
      return;
    }

    const matchObjectId = new mongoose.Types.ObjectId(String(contextMatchId));

    // Validate ownership — never trust client-supplied job data
    const match = await MatchRecord.findOne({ _id: matchObjectId, userId });
    if (!match) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    let conversation;
    try {
      conversation = await ChatConversation.findOneAndUpdate(
        { userId, contextType: "job", contextMatchId: matchObjectId },
        { $setOnInsert: { userId, contextType: "job", contextMatchId: matchObjectId, title: "", messages: [] } },
        { upsert: true, new: true }
      );
    } catch (err: any) {
      // Handle duplicate-key race from concurrent drawer opens
      if (err.code === 11000) {
        conversation = await ChatConversation.findOne({ userId, contextType: "job", contextMatchId: matchObjectId });
      } else {
        throw err;
      }
    }

    if (!conversation) {
      res.status(500).json({ error: "Failed to create or find conversation" });
      return;
    }

    res.json({
      conversationId: String(conversation._id),
      messages: conversation.messages,
    });
  }
);
