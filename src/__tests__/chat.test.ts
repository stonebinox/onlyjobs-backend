// OpenAI mock must be declared before importing chatService (module-level singleton compatible)
jest.mock('openai', () => {
  const mockCreate = jest.fn();
  const MockConstructor = jest.fn().mockReturnValue({
    chat: { completions: { create: mockCreate } },
  });
  (MockConstructor as any).__mockCreate = mockCreate;
  return { __esModule: true, default: MockConstructor };
});

jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

import OpenAI from 'openai';
import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import ChatConversation from '../models/ChatConversation';
import ChatMemory from '../models/ChatMemory';
import User from '../models/User';
import { processMessage, checkRateLimit } from '../services/chatService';
import chatRoutes from '../routes/chatRoutes';

const MockOpenAI = OpenAI as unknown as jest.Mock;

let testUserId: mongoose.Types.ObjectId;
let mockCreate: jest.Mock;

const defaultMockResponse = {
  choices: [{
    message: { role: 'assistant' as const, content: 'Test response', tool_calls: undefined },
    finish_reason: 'stop' as const,
  }],
};

// Build the test app once; req.user is read at request time so testUserId changes work
const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.user = { _id: testUserId };
  next();
});
testApp.use('/api/chat', chatRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

beforeEach(() => {
  testUserId = new mongoose.Types.ObjectId();
  mockCreate = (MockOpenAI as any).__mockCreate as jest.Mock;
  mockCreate.mockClear();
  mockCreate.mockResolvedValue(defaultMockResponse);
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe('ChatConversation model', () => {
  it('creates with required fields', async () => {
    const userId = new mongoose.Types.ObjectId();
    const conv = await ChatConversation.create({ userId, title: 'Test', messages: [] });
    expect(conv._id).toBeDefined();
    expect(conv.userId.toString()).toBe(userId.toString());
    expect(conv.title).toBe('Test');
    expect(conv.messages).toHaveLength(0);
  });

  it('has userId index', async () => {
    const indexes = await ChatConversation.collection.indexes();
    const hasUserIdIndex = indexes.some(idx => idx.key && idx.key.userId === 1);
    expect(hasUserIdIndex).toBe(true);
  });
});

describe('ChatMemory model', () => {
  it('creates with required fields', async () => {
    const userId = new mongoose.Types.ObjectId();
    const memory = await ChatMemory.create({ userId, entries: [] });
    expect(memory._id).toBeDefined();
    expect(memory.userId.toString()).toBe(userId.toString());
    expect(memory.entries).toHaveLength(0);
  });

  it('enforces unique userId constraint', async () => {
    const userId = new mongoose.Types.ObjectId();
    await ChatMemory.create({ userId, entries: [] });
    await expect(ChatMemory.create({ userId, entries: [] })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Chat Service — processMessage
// ---------------------------------------------------------------------------

describe('chatService.processMessage', () => {
  it('creates a new conversation when no conversationId provided', async () => {
    const result = await processMessage(testUserId.toString(), 'Hello');
    expect(result.reply).toBe('Test response');
    expect(result.conversationId).toBeDefined();
    const conv = await ChatConversation.findById(result.conversationId);
    expect(conv).not.toBeNull();
  });

  it('throws Conversation not found for invalid conversationId', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(processMessage(testUserId.toString(), 'Hello', fakeId))
      .rejects.toThrow('Conversation not found');
  });

  it('throws Conversation not found when conversationId belongs to different user', async () => {
    const otherUserId = new mongoose.Types.ObjectId();
    const conv = await ChatConversation.create({ userId: otherUserId, title: '', messages: [] });
    await expect(processMessage(testUserId.toString(), 'Hello', (conv._id as mongoose.Types.ObjectId).toString()))
      .rejects.toThrow('Conversation not found');
  });

  it('appends user message and assistant reply to conversation', async () => {
    const result = await processMessage(testUserId.toString(), 'Hello');
    const conv = await ChatConversation.findById(result.conversationId);
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.messages[0].role).toBe('user');
    expect(conv!.messages[0].content).toBe('Hello');
    expect(conv!.messages[1].role).toBe('assistant');
    expect(conv!.messages[1].content).toBe('Test response');
  });

  it('sets conversation title from first message, truncated to 50 chars', async () => {
    const longMsg = 'A'.repeat(60);
    const result = await processMessage(testUserId.toString(), longMsg);
    const conv = await ChatConversation.findById(result.conversationId);
    expect(conv!.title).toBe('A'.repeat(50));
  });
});

// ---------------------------------------------------------------------------
// Chat Service — rate limiting
// ---------------------------------------------------------------------------

describe('chatService.checkRateLimit', () => {
  it('returns true when under limit', async () => {
    const result = await checkRateLimit(testUserId.toString());
    expect(result).toBe(true);
  });

  it('returns true when under 50 messages in the last hour', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i}`,
      createdAt: new Date(),
    }));
    await ChatConversation.create({ userId: testUserId, title: 'Rate limit test', messages });
    const result = await checkRateLimit(testUserId.toString());
    expect(result).toBe(true);
  });

  it('returns false when at 50 messages in the last hour', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i}`,
      createdAt: new Date(),
    }));
    await ChatConversation.create({ userId: testUserId, title: 'Rate limit test', messages });
    const result = await checkRateLimit(testUserId.toString());
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Chat Service — memory (save_memory tool)
// ---------------------------------------------------------------------------

function saveMemoryToolCallResponse(key: string, value: string) {
  return {
    choices: [{
      message: {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{
          id: 'tc_1',
          type: 'function' as const,
          function: { name: 'save_memory', arguments: JSON.stringify({ key, value }) },
        }],
      },
      finish_reason: 'tool_calls' as const,
    }],
  };
}

describe('chatService memory', () => {
  it('save_memory creates a new entry', async () => {
    mockCreate
      .mockResolvedValueOnce(saveMemoryToolCallResponse('pref_role', 'software engineer'))
      .mockResolvedValueOnce(defaultMockResponse);

    await processMessage(testUserId.toString(), 'I want to be a software engineer');

    const memory = await ChatMemory.findOne({ userId: testUserId });
    expect(memory).not.toBeNull();
    expect(memory!.entries).toHaveLength(1);
    expect(memory!.entries[0].key).toBe('pref_role');
    expect(memory!.entries[0].value).toBe('software engineer');
  });

  it('save_memory updates existing entry when key matches', async () => {
    const convId = new mongoose.Types.ObjectId().toString();
    await ChatMemory.create({
      userId: testUserId,
      entries: [{ key: 'pref_role', value: 'old value', source: convId, createdAt: new Date(), updatedAt: new Date() }],
    });

    mockCreate
      .mockResolvedValueOnce(saveMemoryToolCallResponse('pref_role', 'new value'))
      .mockResolvedValueOnce(defaultMockResponse);

    await processMessage(testUserId.toString(), 'Update my role');

    const memory = await ChatMemory.findOne({ userId: testUserId });
    expect(memory!.entries).toHaveLength(1);
    expect(memory!.entries[0].value).toBe('new value');
  });

  it('prunes oldest entries when memory exceeds 50', async () => {
    const oldDate = new Date(Date.now() - 100_000);
    const convId = new mongoose.Types.ObjectId().toString();

    const entries = Array.from({ length: 50 }, (_, i) => ({
      key: `key_${i}`,
      value: `value_${i}`,
      source: convId,
      createdAt: oldDate,
      updatedAt: oldDate,
    }));
    await ChatMemory.create({ userId: testUserId, entries });

    mockCreate
      .mockResolvedValueOnce(saveMemoryToolCallResponse('key_new', 'value_new'))
      .mockResolvedValueOnce(defaultMockResponse);

    await processMessage(testUserId.toString(), 'Add new memory');

    const memory = await ChatMemory.findOne({ userId: testUserId });
    expect(memory!.entries).toHaveLength(50);
    expect(memory!.entries.some(e => e.key === 'key_new')).toBe(true);
    expect(memory!.entries.some(e => e.key === 'key_0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Controller — integration via supertest
// ---------------------------------------------------------------------------

describe('chat controller', () => {
  it('POST /api/chat returns 400 for empty message', async () => {
    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: '' });
    expect(res.status).toBe(400);
  });

  it('POST /api/chat returns 200 with reply and conversationId', async () => {
    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: 'Hello' });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Test response');
    expect(res.body.conversationId).toBeDefined();
  });

  it('POST /api/chat returns 429 when rate limited', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i}`,
      createdAt: new Date(),
    }));
    await ChatConversation.create({ userId: testUserId, title: 'Test', messages });

    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: 'Hello' });
    expect(res.status).toBe(429);
  });

  it('GET /api/chat/conversations returns user conversations', async () => {
    await ChatConversation.create({ userId: testUserId, title: 'Conv 1', messages: [] });
    await ChatConversation.create({ userId: testUserId, title: 'Conv 2', messages: [] });

    const res = await request(testApp).get('/api/chat/conversations');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('GET /api/chat/conversations/:id returns 404 for wrong user conversation', async () => {
    const otherUserId = new mongoose.Types.ObjectId();
    const conv = await ChatConversation.create({ userId: otherUserId, title: 'Other', messages: [] });

    const res = await request(testApp).get(`/api/chat/conversations/${conv._id}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/chat/memory returns empty array when no memory', async () => {
    const res = await request(testApp).get('/api/chat/memory');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('DELETE /api/chat/memory returns success', async () => {
    const convId = new mongoose.Types.ObjectId().toString();
    await ChatMemory.create({
      userId: testUserId,
      entries: [{ key: 'k', value: 'v', source: convId, createdAt: new Date(), updatedAt: new Date() }],
    });

    const res = await request(testApp).delete('/api/chat/memory');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chat Service — compact profile context injection (deterministic, no tool call)
// ---------------------------------------------------------------------------

describe('chatService compact profile context injection', () => {
  it('injects profile and Q&A into system prompt without requiring a tool call', async () => {
    const user = await User.create({
      email: `test-inject-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Jane Dev',
      resume: {
        summary: 'Full-stack developer',
        skills: ['TypeScript', 'React'],
        experience: ['Led engineering at Startup X'],
      },
      qna: [
        { questionId: 'your-story', answer: 'I built X and Y in my career', mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'help me answer this application question: why should we hire you?');

    // Profile context is injected: only one OpenAI call (no tool round-trip needed)
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain('Jane Dev');
    expect(systemMsg.content).toContain('Full-stack developer');
    expect(systemMsg.content).toContain('TypeScript');
    expect(systemMsg.content).toContain('I built X and Y in my career');
  });

  it('system prompt frames assistant as able to draft and refine job-application answers', async () => {
    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toMatch(/draft|application answer|application question/i);
    expect(systemMsg.content).toMatch(/voice/i);
  });

  it('injected context is wrapped in prompt-injection safety delimiters', async () => {
    const user = await User.create({
      email: `test-delim-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Delim User',
      resume: { skills: ['Go'] },
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('<user_profile_data>');
    expect(systemMsg.content).toContain('</user_profile_data>');
    expect(systemMsg.content).toMatch(/REFERENCE DATA|reference data/);
  });

  it('injected context does not contain auth fields', async () => {
    const user = await User.create({
      email: `test-auth-safe-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'super-secret-hash',
      name: 'Secure User',
      resume: { skills: ['JS'] },
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Tell me about myself');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    expect(content).not.toContain('super-secret-hash');
    expect(content).not.toContain('"password"');
    expect(content).not.toContain('emailVerificationToken');
    expect(content).not.toContain('passwordResetToken');
    expect(content).not.toContain('pendingEmail');
  });

  it('handles empty Q&A without crashing and still includes profile data', async () => {
    const user = await User.create({
      email: `test-empty-qna-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Empty QnA User',
      resume: { skills: ['Go'], summary: 'A developer' },
      qna: [],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await expect(processMessage(testUserId.toString(), 'Hello')).resolves.toBeDefined();

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('Empty QnA User');
    expect(systemMsg.content).toContain('A developer');
    // No Q&A section since there are none
    expect(systemMsg.content).not.toContain('Q: ');
  });

  it('represents skipped Q&A entries as [skipped] in injected context', async () => {
    const user = await User.create({
      email: `test-skipped-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Skip User',
      resume: { skills: ['Python'] },
      qna: [
        { questionId: 'your-story', answer: '', mode: 'text', skipped: true },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    expect(content).toContain('[skipped]');
    // The skipped question text (or questionId fallback) should appear, but not as a real answer
    expect(content).not.toContain('A: I built');
  });

  it('includes voice-transcribed answers in injected context', async () => {
    const user = await User.create({
      email: `test-voice-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Voice User',
      resume: { skills: ['Rust'] },
      qna: [
        { questionId: 'fun-activities', answer: 'I love hiking and climbing', mode: 'voice', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('I love hiking and climbing');
  });

  it('falls back to questionId string for stale/unknown question IDs', async () => {
    const user = await User.create({
      email: `test-stale-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Stale ID User',
      resume: { skills: ['C++'] },
      qna: [
        { questionId: 'unknown-question-xyz-stale', answer: 'Some answer here', mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('unknown-question-xyz-stale');
    expect(systemMsg.content).toContain('Some answer here');
  });

  it('caps Q&A entries at 12 (COMPACT_QNA_MAX_ENTRIES)', async () => {
    const qnaEntries = Array.from({ length: 20 }, (_, i) => ({
      questionId: `q-fake-${i}`,
      answer: `Answer to question number ${i}`,
      mode: 'text' as const,
      skipped: false,
    }));

    const user = await User.create({
      email: `test-cap-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Cap User',
      resume: { skills: ['C++'] },
      qna: qnaEntries,
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    const qnaMatches = content.match(/^Q: /gm);
    expect(qnaMatches).not.toBeNull();
    expect(qnaMatches!.length).toBeLessThanOrEqual(12);
  });

  it('truncates long Q&A answers at 400 chars with ellipsis', async () => {
    const longAnswer = 'A'.repeat(600);
    const user = await User.create({
      email: `test-long-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Long Answer User',
      resume: { skills: ['Java'] },
      qna: [
        { questionId: 'your-story', answer: longAnswer, mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    expect(content).not.toContain('A'.repeat(600));
    expect(content).toContain('A'.repeat(400) + '...');
  });

  it('total injected block is bounded under COMPACT_BLOCK_MAX_CHARS', async () => {
    const longAnswer = 'B'.repeat(500);
    const qnaEntries = Array.from({ length: 15 }, (_, i) => ({
      questionId: `q-big-${i}`,
      answer: longAnswer,
      mode: 'text' as const,
      skipped: false,
    }));

    const user = await User.create({
      email: `test-bounded-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Bounded User',
      resume: {
        skills: Array.from({ length: 50 }, (_, i) => `skill${i}`),
        summary: 'C'.repeat(1000),
      },
      qna: qnaEntries,
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    // The profile block itself is capped at 4000 chars; the total system prompt has static text too
    // but should stay well under a reasonable ceiling
    expect(systemMsg.content.length).toBeLessThan(10000);
    // The truncation marker should appear
    expect(systemMsg.content).toContain('[...truncated]');
  });

  it('prefers answered Q&A entries over skipped ones when capping', async () => {
    // 8 skipped first in array, then 8 answered — cap is 12 so answered should dominate
    const skippedEntries = Array.from({ length: 8 }, (_, i) => ({
      questionId: `q-skip-${i}`,
      answer: '',
      mode: 'text' as const,
      skipped: true,
    }));
    const answeredEntries = Array.from({ length: 8 }, (_, i) => ({
      questionId: `q-ans-${i}`,
      answer: `Real answer ${i}`,
      mode: 'text' as const,
      skipped: false,
    }));

    const user = await User.create({
      email: `test-prefer-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Prefer User',
      resume: { skills: ['Elixir'] },
      qna: [...skippedEntries, ...answeredEntries],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    // All 8 answered entries should appear (they get priority)
    for (let i = 0; i < 8; i++) {
      expect(content).toContain(`Real answer ${i}`);
    }
    // Only 4 skipped slots remain (12 - 8 = 4), so not all 8 skipped appear
    const skippedMatches = (content.match(/\[skipped\]/g) ?? []).length;
    expect(skippedMatches).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Chat Service — get_user_profile_summary returns full Q&A
// ---------------------------------------------------------------------------

describe('chatService get_user_profile_summary', () => {
  it('returns questionsAndAnswers with text and voice answers, no auth fields', async () => {
    const uniqueEmail = `test-qna-${new mongoose.Types.ObjectId().toString()}@example.com`;
    const user = await User.create({
      email: uniqueEmail,
      password: 'hashed-password',
      name: 'Test User',
      resume: {
        skills: ['TypeScript'],
        experience: ['Built stuff'],
        summary: 'A developer',
      },
      qna: [
        { questionId: 'your-story', answer: 'I built X and Y', mode: 'text', skipped: false },
        { questionId: 'fun-activities', answer: 'I hike', mode: 'voice', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    mockCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [{
              id: 'tc_profile',
              type: 'function' as const,
              function: { name: 'get_user_profile_summary', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls' as const,
        }],
      })
      .mockResolvedValueOnce(defaultMockResponse);

    await processMessage(testUserId.toString(), 'Tell me about my Q&A answers');

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const secondCallMessages = mockCreate.mock.calls[1][0].messages as any[];
    const toolMsg = secondCallMessages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();

    const toolContent = JSON.parse(toolMsg.content);
    expect(toolContent.questionsAndAnswers).toBeDefined();
    expect(Array.isArray(toolContent.questionsAndAnswers)).toBe(true);

    const storyEntry = toolContent.questionsAndAnswers.find(
      (q: any) => q.question === 'What is your story?'
    );
    expect(storyEntry).toBeDefined();
    expect(storyEntry.answer).toBe('I built X and Y');
    expect(storyEntry.mode).toBe('text');

    const hikeEntry = toolContent.questionsAndAnswers.find(
      (q: any) => q.question === 'What do you do for fun?'
    );
    expect(hikeEntry).toBeDefined();
    expect(hikeEntry.answer).toBe('I hike');
    expect(hikeEntry.mode).toBe('voice');

    // Verify no auth fields leaked
    const contentStr = toolMsg.content;
    expect(contentStr).not.toContain('passwordResetToken');
    expect(contentStr).not.toContain('emailVerificationToken');
    expect(contentStr).not.toContain('password');
  });
});
