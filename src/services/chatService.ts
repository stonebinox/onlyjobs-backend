import OpenAI from "openai";
import mongoose from "mongoose";
import ChatConversation from "../models/ChatConversation";
import ChatMemory from "../models/ChatMemory";
import MatchRunLog from "../models/MatchRunLog";
import MatchRecord from "../models/MatchRecord";
import User from "../models/User";
import FieldProfile from "../models/FieldProfile";

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_match_run_logs",
      description: "Retrieve the user's recent job matching run logs to see how the daily matching has been going.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Number of past days to look back (default: 30)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_profile_summary",
      description: "Retrieve a summary of the user's profile including skills, experience, and preferences.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_match_statistics",
      description: "Get aggregated statistics about the user's job matches including score distribution, skip reasons, and application counts.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Number of past days to analyse (default: 90)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_successful_profiles_in_field",
      description: "Compare the user's profile against successful profiles in a given field.",
      parameters: {
        type: "object",
        properties: {
          field: {
            type: "string",
            description: "The job field or industry to compare against",
          },
        },
        required: ["field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save an important piece of information about the user for future conversations.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "A short identifier for this piece of information (e.g. 'preferred_role', 'target_salary')",
          },
          value: {
            type: "string",
            description: "The information to remember",
          },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      description: "Update an existing piece of information about the user that was previously saved.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "The identifier of the information to update (e.g. 'preferred_role', 'target_salary')",
          },
          value: {
            type: "string",
            description: "The updated information",
          },
        },
        required: ["key", "value"],
      },
    },
  },
];

function buildSystemPrompt(memoryEntries: { key: string; value: string }[]): string {
  let prompt = `You are the OnlyJobs AI assistant, helping users understand their job matching results and improve their profiles.

OnlyJobs works like this:
- Jobs are scraped daily from various sources
- Each job is matched against the user's profile using AI scoring (0–100)
- Before AI scoring, jobs go through pre-filters: remote-only preference, minimum salary, location, and relevance
- Only jobs above the user's minimum score threshold appear in their feed
- Users pay $0.30/day for matching to run
- Users can skip jobs (with reasons) and apply to matches; the system learns their preferences over time

Your personality: friendly, concise, and actionable. Give specific advice the user can act on. Avoid vague suggestions.

When you learn something important about the user (their target role, salary expectations, preferred industries, frustrations, goals), use the save_memory tool to remember it for future conversations. Use save_memory when you learn something new about the user. Use update_memory when you need to correct or update an existing memory.`;

  if (memoryEntries.length > 0) {
    prompt += `\n\nWhat I know about you:\n`;
    for (const entry of memoryEntries) {
      prompt += `- ${entry.key}: ${entry.value}\n`;
    }
  }

  return prompt;
}

async function executeToolCall(
  userId: string | mongoose.Types.ObjectId,
  conversationId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const userObjectId = new mongoose.Types.ObjectId(userId);

  if (toolName === "get_match_run_logs") {
    const days = typeof args.days === "number" ? args.days : 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const logs = await MatchRunLog.find({
      userId: userObjectId,
      runAt: { $gte: since },
    })
      .sort({ runAt: -1 })
      .limit(30)
      .lean();

    if (logs.length === 0) {
      const [totalMatches, totalSkipped] = await Promise.all([
        MatchRecord.countDocuments({ userId: userObjectId, createdAt: { $gte: since }, skipped: false }),
        MatchRecord.countDocuments({ userId: userObjectId, createdAt: { $gte: since }, skipped: true }),
      ]);
      return {
        logs: [],
        fallback: {
          totalMatches,
          totalSkipped,
          period: `last ${days} days`,
          note: "Detailed run logs are not yet available. These statistics are based on individual match records and may be less precise.",
        },
      };
    }

    return logs.map((log) => ({
      runAt: log.runAt,
      outcome: log.outcome,
      reasonCode: log.reasonCode,
      reasonSummary: log.reasonSummary,
      matchesCreated: log.matchesCreated,
      preFilterResults: log.preFilterResults,
    }));
  }

  if (toolName === "get_user_profile_summary") {
    const user = await User.findById(userObjectId).lean();
    if (!user) return { error: "User not found" };

    const experience = (user.resume?.experience ?? []).slice(0, 5).map((e) =>
      typeof e === "string" ? e : e.text
    );

    return {
      name: user.name,
      skills: user.resume?.skills ?? [],
      experience,
      preferences: user.preferences,
      summary: user.resume?.summary ?? "",
      socialLinks: user.socialLinks ?? {},
    };
  }

  if (toolName === "get_match_statistics") {
    const days = typeof args.days === "number" ? args.days : 90;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [totals, skipReasons, appliedCount] = await Promise.all([
      MatchRecord.aggregate([
        { $match: { userId: userObjectId, createdAt: { $gte: since }, skipped: false } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            score0to30: { $sum: { $cond: [{ $lte: ["$matchScore", 30] }, 1, 0] } },
            score31to50: { $sum: { $cond: [{ $and: [{ $gt: ["$matchScore", 30] }, { $lte: ["$matchScore", 50] }] }, 1, 0] } },
            score51to70: { $sum: { $cond: [{ $and: [{ $gt: ["$matchScore", 50] }, { $lte: ["$matchScore", 70] }] }, 1, 0] } },
            score71to100: { $sum: { $cond: [{ $gt: ["$matchScore", 70] }, 1, 0] } },
          },
        },
      ]),
      MatchRecord.aggregate([
        {
          $match: {
            userId: userObjectId,
            createdAt: { $gte: since },
            skipped: true,
            "skipReason.category": { $exists: true },
          },
        },
        { $group: { _id: "$skipReason.category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      MatchRecord.countDocuments({ userId: userObjectId, createdAt: { $gte: since }, applied: true }),
    ]);

    const stats = totals[0] ?? { total: 0, score0to30: 0, score31to50: 0, score51to70: 0, score71to100: 0 };

    return {
      totalMatches: stats.total,
      scoreDistribution: {
        "0-30": stats.score0to30,
        "31-50": stats.score31to50,
        "51-70": stats.score51to70,
        "71-100": stats.score71to100,
      },
      topSkipReasons: skipReasons.map((r) => ({ reason: r._id, count: r.count })),
      appliedCount,
    };
  }

  if (toolName === "get_successful_profiles_in_field") {
    const requestedField = String(args.field ?? "").toLowerCase().replace(/\s+/g, "_");

    // Load all available profiles to support fuzzy matching and available-fields list
    const allProfiles = await FieldProfile.find({ sampleSize: { $gte: 5 } })
      .select("field sampleSize topSkills commonPreferences updatedAt")
      .lean();

    const availableFields = allProfiles.map((p) => p.field);

    // Try exact match first, then partial match
    let profile = allProfiles.find((p) => p.field === requestedField);
    if (!profile) {
      profile = allProfiles.find(
        (p) => p.field.includes(requestedField) || requestedField.includes(p.field)
      );
    }

    if (!profile) {
      return {
        available: false,
        message: `Not enough data for this field yet. Try a broader field like 'backend_engineering' or 'frontend_engineering'.`,
        availableFields,
      };
    }

    const user = await User.findById(userObjectId)
      .select("resume.skills preferences.remoteOnly preferences.minSalary")
      .lean();

    const userSkills = (user?.resume?.skills ?? []).map((s) => s.toLowerCase().trim());

    const skillGaps = profile.topSkills
      .filter((s) => !userSkills.includes(s.name.toLowerCase().trim()))
      .slice(0, 10)
      .map((s) => s.name);

    return {
      available: true,
      field: profile.field,
      sampleSize: profile.sampleSize,
      updatedAt: profile.updatedAt.toISOString().split("T")[0],
      skillGaps,
      userSkills: user?.resume?.skills ?? [],
      topFieldSkills: profile.topSkills.slice(0, 15),
      preferenceComparison: {
        fieldRemoteOnlyPercent: profile.commonPreferences.remoteOnlyPercent,
        userRemoteOnly: user?.preferences?.remoteOnly ?? false,
        fieldAvgMinSalary: profile.commonPreferences.avgMinSalary,
        userMinSalary: user?.preferences?.minSalary ?? 0,
      },
    };
  }

  if (toolName === "save_memory" || toolName === "update_memory") {
    const key = String(args.key ?? "");
    const value = String(args.value ?? "");
    const now = new Date();

    const memory = await ChatMemory.findOne({ userId: userObjectId });

    if (memory) {
      const existing = memory.entries.find((e) => e.key === key);
      if (existing) {
        existing.value = value;
        existing.updatedAt = now;
      } else {
        memory.entries.push({ key, value, source: conversationId, createdAt: now, updatedAt: now });
      }
      if (memory.entries.length > 50) {
        memory.entries.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
        memory.entries.splice(0, memory.entries.length - 50);
      }
      await memory.save();
    } else {
      await ChatMemory.create({
        userId: userObjectId,
        entries: [{ key, value, source: conversationId, createdAt: now, updatedAt: now }],
      });
    }

    return { saved: true };
  }

  return { error: `Unknown tool: ${toolName}` };
}

const CONVERSATION_CUTOFF = 20;

async function summarizeOlderMessages(
  openai: OpenAI,
  messages: { role: string; content: string }[],
  existingSummary?: string
): Promise<string> {
  const conversationText = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const systemPrompt = "Summarize this conversation concisely. Focus on: what the user asked about, key information revealed, decisions made, and any unresolved questions. Keep it under 200 words.";

  const userContent = existingSummary
    ? `Previous summary: ${existingSummary}\n\nNow also summarize these additional messages:\n${conversationText}`
    : conversationText;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  return response.choices[0].message.content ?? "";
}

export async function processMessage(
  userId: string | mongoose.Types.ObjectId,
  message: string,
  conversationId?: string
): Promise<{ reply: string; conversationId: string }> {
  const userObjectId = new mongoose.Types.ObjectId(userId);

  // Load or create conversation
  let conversation = conversationId
    ? await ChatConversation.findOne({ _id: conversationId, userId: userObjectId })
    : null;

  if (conversationId && !conversation) {
    throw new Error('Conversation not found');
  }

  if (!conversation) {
    conversation = new ChatConversation({ userId: userObjectId, title: "", messages: [] });
  }

  // Set title from first message
  if (conversation.messages.length === 0) {
    conversation.title = message.slice(0, 50);
  }

  // Append user message
  conversation.messages.push({ role: "user", content: message, createdAt: new Date() });

  // Load memory
  const memory = await ChatMemory.findOne({ userId: userObjectId }).lean();
  const memoryEntries = memory?.entries ?? [];

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Build OpenAI messages (last CONVERSATION_CUTOFF only, with AI summary if conversation is longer)
  const allMessages = conversation.messages;
  const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(memoryEntries) },
  ];

  if (allMessages.length > CONVERSATION_CUTOFF) {
    const cutoffIndex = allMessages.length - CONVERSATION_CUTOFF;
    const existingSummaryUpTo = conversation.summaryUpToIndex ?? 0;

    let summary = conversation.summary;

    // Only re-summarize if there are new messages beyond what was previously summarized
    if (!summary || existingSummaryUpTo < cutoffIndex) {
      const messagesToSummarize = allMessages.slice(existingSummaryUpTo, cutoffIndex);
      try {
        summary = await withTimeout(
          summarizeOlderMessages(openai, messagesToSummarize, summary ?? undefined),
          10000,
          "summarize_conversation"
        );
        conversation.summary = summary;
        conversation.summaryUpToIndex = cutoffIndex;
      } catch {
        // Fall back to first-message snippet approach
        const firstMessage = allMessages[0];
        const truncatedFirst = firstMessage.content.slice(0, 100);
        summary = undefined;
        openaiMessages.push({
          role: "system",
          content: `Earlier in this conversation, the user initially asked: "${truncatedFirst}". The conversation has had ${allMessages.length} messages total. Here are the most recent ${CONVERSATION_CUTOFF}:`,
        });
      }
    }

    if (summary) {
      openaiMessages.push({
        role: "system",
        content: `Summary of earlier conversation: ${summary}`,
      });
    }
  }

  const recentMessages = allMessages.slice(-CONVERSATION_CUTOFF);
  openaiMessages.push(
    ...recentMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
  );

  let reply = "";
  let iterations = 0;
  const MAX_ITERATIONS = 5;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await withTimeout(openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: openaiMessages,
      tools: TOOLS,
      tool_choice: "auto",
    }), 30000, "openai.chat.completions.create");

    const choice = response.choices[0];
    const responseMessage = choice.message;

    if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
      reply = responseMessage.content ?? "";
      break;
    }

    // Add assistant message with tool calls
    openaiMessages.push(responseMessage);

    // Execute each tool call and append results
    for (const toolCall of responseMessage.tool_calls) {
      if (toolCall.type !== "function") continue;
      let toolResult: unknown;
      try {
        const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        console.log(`[Chat] Tool call: ${toolCall.function.name}(${toolCall.function.arguments})`);
        toolResult = await withTimeout(executeToolCall(userId, String(conversation._id), toolCall.function.name, args), 15000, toolCall.function.name);
        console.log(`[Chat] Tool result: ${JSON.stringify(toolResult).substring(0, 200)}`);
      } catch (err) {
        toolResult = { error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      openaiMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  if (!reply) {
    reply = "I'm sorry, I wasn't able to generate a response. Please try again.";
  }

  // Append assistant reply to conversation
  conversation.messages.push({ role: "assistant", content: reply, createdAt: new Date() });
  await conversation.save();

  return { reply, conversationId: String(conversation._id) };
}

export async function checkRateLimit(userId: string | mongoose.Types.ObjectId): Promise<boolean> {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const result = await ChatConversation.aggregate([
    { $match: { userId: userObjectId } },
    { $unwind: "$messages" },
    {
      $match: {
        "messages.role": "user",
        "messages.createdAt": { $gte: oneHourAgo },
      },
    },
    { $count: "total" },
  ]);

  const count = result[0]?.total ?? 0;
  return count < 50;
}
