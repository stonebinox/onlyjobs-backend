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
// Chat Service — profile context injection (deterministic, no tool call)
// ---------------------------------------------------------------------------

describe('chatService profile context injection', () => {
  it('injects profile and relevant Q&A into system prompt without requiring a tool call', async () => {
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
        // "hire" token matches question "Why should a company hire you?" and the answer body
        { questionId: 'why-hire-you', answer: 'Companies should hire me because I build reliable systems and ship on time', mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'help me answer this application question: why should we hire you?');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain('Jane Dev');
    expect(systemMsg.content).toContain('Full-stack developer');
    expect(systemMsg.content).toContain('TypeScript');
    expect(systemMsg.content).toContain('Companies should hire me because I build reliable systems');
  });

  it('system prompt frames assistant as able to draft and refine job-application answers', async () => {
    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toMatch(/draft|application answer|application question/i);
    expect(systemMsg.content).toMatch(/voice/i);
  });

  it('profile basics are wrapped in prompt-injection safety delimiters', async () => {
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

  it('Q&A body is wrapped in user_qna_data delimiters when relevant answers are injected', async () => {
    const user = await User.create({
      email: `test-qna-delim-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'QnA Delim User',
      resume: { skills: ['Go'] },
      qna: [
        { questionId: 'leadership-style', answer: 'I use collaborative leadership and empower teams', mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Tell me about your leadership style');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    expect(content).toContain('<user_qna_data>');
    expect(content).toContain('</user_qna_data>');
    // Guard instruction present inside qna block
    expect(content).toMatch(/REFERENCE DATA/);
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
    const content = systemMsg.content as string;
    expect(content).toContain('Empty QnA User');
    expect(content).toContain('A developer');
    // No Q&A body and no corpus summary when qna array is empty
    expect(content).not.toContain('Q: ');
    expect(content).not.toContain('the user has answered');
  });

  it('corpus summary line is always present when user has Q&A entries', async () => {
    const user = await User.create({
      email: `test-corpus-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Corpus User',
      resume: { skills: ['Node'] },
      qna: [
        { questionId: 'your-story', answer: 'I started coding at 12', mode: 'text', skipped: false },
        { questionId: 'fun-activities', answer: '', mode: 'text', skipped: true },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    // 1 answered of 2 total
    expect(content).toContain('answered 1 of 2 questions');
    expect(content).toContain('categories:');
  });

  it('skipped entries are excluded from Q&A body and counted as unanswered in corpus summary', async () => {
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

    // "story" matches question text but entry is skipped → no body injected
    await processMessage(testUserId.toString(), 'Tell me your story');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    // Skipped entries must NOT appear in Q&A body
    expect(content).not.toContain('[skipped]');
    expect(content).not.toContain('<user_qna_data>');
    // Corpus summary reflects 0 answered of 1 total
    expect(content).toContain('answered 0 of 1 questions');
  });

  it('includes voice-transcribed answers in injected context when message is relevant', async () => {
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

    // "fun" token matches question "What do you do for fun?" → answer injected
    await processMessage(testUserId.toString(), 'What do you do for fun and hobbies');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('I love hiking and climbing');
  });

  it('falls back to questionId string for stale/unknown question IDs when answer is relevant', async () => {
    const user = await User.create({
      email: `test-stale-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Stale ID User',
      resume: { skills: ['C++'] },
      qna: [
        { questionId: 'unknown-question-xyz-stale', answer: 'My xyz stale framework work has been extensive', mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    // "xyz" and "stale" match both the questionId fallback text and the answer body
    await processMessage(testUserId.toString(), 'Tell me about your xyz stale experience');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    // questionId used as fallback question text
    expect(content).toContain('unknown-question-xyz-stale');
    expect(content).toContain('My xyz stale framework work');
  });

  it('selects the relevant answer from position 30+ in the array without a tool call', async () => {
    // 30 filler entries followed by the relevant answer about leadership at index 30
    const fillerEntries = Array.from({ length: 30 }, (_, i) => ({
      questionId: `q-filler-${i}`,
      answer: `Filler answer number ${i} about random unrelated topics`,
      mode: 'text' as const,
      skipped: false,
    }));
    const targetEntry = {
      questionId: 'leadership-style',
      answer: 'I lead by example and foster psychological safety in my teams',
      mode: 'text' as const,
      skipped: false,
    };

    const user = await User.create({
      email: `test-relevant-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Relevant User',
      resume: { skills: ['Go'] },
      qna: [...fillerEntries, targetEntry],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    // Only one OpenAI call expected — full Q&A injection (general conversation) brings in the answer
    await processMessage(testUserId.toString(), 'How would you describe your leadership style?');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    expect(content).toContain('I lead by example and foster psychological safety');
    // Full injection includes all entries — filler is also present
    expect(content).toContain('Filler answer number 0');
  });

  it('unrelated prompt injects no Q&A body', async () => {
    const user = await User.create({
      email: `test-unrelated-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Unrelated User',
      resume: { skills: ['Java'] },
      qna: [
        { questionId: 'your-story', answer: 'I built many projects over the years', mode: 'text', skipped: false },
        { questionId: 'leadership-style', answer: 'I prefer servant leadership approaches', mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    // Pure greeting — full Q&A injection for general conversations always injects all answers
    await processMessage(testUserId.toString(), 'Hello there');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    // General conversation: full Q&A block always injected, regardless of message keyword match
    expect(content).toContain('<user_qna_data>');
    expect(content).toContain('I built many projects over the years');
    expect(content).toContain('I prefer servant leadership approaches');
  });

  it('truncates long Q&A answers at 600 chars with ellipsis', async () => {
    const longAnswer = 'A'.repeat(700);
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

    // General conversation: full Q&A injection; per-answer cap is 2000 chars (700 < 2000, not truncated)
    await processMessage(testUserId.toString(), 'Tell me your story');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    // 700-char answer is under the 2000-char per-answer cap — full answer is injected
    expect(content).toContain('A'.repeat(700));
    expect(content).not.toContain('A'.repeat(700) + '...');
  });

  it('profile basics block is bounded at 4000 chars', async () => {
    const user = await User.create({
      email: `test-bounded-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Bounded User',
      resume: {
        skills: Array.from({ length: 50 }, (_, i) => `skill${i}`),
        // 5000-char summary pushes basics block over the 4000-char cap
        summary: 'C'.repeat(5000),
      },
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Hello');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    expect(content.length).toBeLessThan(10000);
    expect(content).toContain('[...truncated]');
  });

  it('show all Q&A intent injects all non-skipped answered entries', async () => {
    const answeredEntries = Array.from({ length: 20 }, (_, i) => ({
      questionId: `q-show-${i}`,
      answer: `Answer for show-all entry ${i}`,
      mode: 'text' as const,
      skipped: false,
    }));
    const skippedEntries = Array.from({ length: 3 }, (_, i) => ({
      questionId: `q-skip-show-${i}`,
      answer: '',
      mode: 'text' as const,
      skipped: true,
    }));

    const user = await User.create({
      email: `test-showall-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Show All User',
      resume: { skills: ['Python'] },
      qna: [...answeredEntries, ...skippedEntries],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'show me all my Q&A answers');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    // All 20 answered entries injected
    const qMatches = (content.match(/^Q:/gm) ?? []).length;
    expect(qMatches).toBe(20);
    // Skipped entries absent
    expect(content).not.toContain('q-skip-show-0');
    expect(content).toContain('<user_qna_data>');
  });

  it('show all Q&A block is bounded when total answers exceed the ceiling', async () => {
    // Each answer is 350 chars — under the 2000-char per-answer cap used by buildFullQnaBlock
    const longAnswer = 'X'.repeat(350);
    const manyEntries = Array.from({ length: 40 }, (_, i) => ({
      questionId: `q-huge-${i}`,
      answer: longAnswer,
      mode: 'text' as const,
      skipped: false,
    }));

    const user = await User.create({
      email: `test-showall-bound-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Huge User',
      resume: { skills: ['Go'] },
      qna: manyEntries,
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'list all my answers');

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    // 350-char answers are under the 2000-char per-answer cap — fully included, not truncated
    expect(content).toContain('X'.repeat(350));
    expect(content).not.toContain('X'.repeat(350) + '...');
    // All 40 entries fit within the 24000-char total budget (~14700 chars actual)
    const qMatches = (content.match(/^Q:/gm) ?? []).length;
    expect(qMatches).toBe(40);
  });

  it('feature flag disabled: Q&A bodies not injected, profile basics and corpus summary still present', async () => {
    const user = await User.create({
      email: `test-flag-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'Flag User',
      resume: { skills: ['Ruby'], summary: 'Backend engineer' },
      qna: [
        { questionId: 'leadership-style', answer: 'I prefer collaborative leadership', mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    const origFlag = process.env.CHAT_QNA_RETRIEVAL_ENABLED;
    process.env.CHAT_QNA_RETRIEVAL_ENABLED = 'false';
    try {
      await processMessage(testUserId.toString(), 'Tell me about leadership');
    } finally {
      if (origFlag === undefined) {
        delete process.env.CHAT_QNA_RETRIEVAL_ENABLED;
      } else {
        process.env.CHAT_QNA_RETRIEVAL_ENABLED = origFlag;
      }
    }

    const firstCallMessages = mockCreate.mock.calls[0][0].messages as any[];
    const systemMsg = firstCallMessages.find((m: any) => m.role === 'system');
    const content = systemMsg.content as string;
    // Profile basics still present
    expect(content).toContain('Flag User');
    expect(content).toContain('Backend engineer');
    // Corpus summary still present (part of profile basics block)
    expect(content).toContain('answered 1 of 1 questions');
    // Q&A body NOT injected
    expect(content).not.toContain('I prefer collaborative leadership');
    expect(content).not.toContain('<user_qna_data>');
  });

  it('no raw Q&A answer content appears in console logs', async () => {
    const sensitiveAnswer = 'SECRET_ANSWER_CONTENT_THAT_MUST_NOT_BE_LOGGED_XYZ';
    const user = await User.create({
      email: `test-nolog-${new mongoose.Types.ObjectId()}@example.com`,
      password: 'hashed',
      name: 'No Log User',
      resume: { skills: ['Go'] },
      qna: [
        { questionId: 'leadership-style', answer: sensitiveAnswer, mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await processMessage(testUserId.toString(), 'Tell me about leadership');
    } finally {
      logSpy.mockRestore();
    }

    const loggedMessages = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(loggedMessages).not.toContain(sensitiveAnswer);
  });
});

// ---------------------------------------------------------------------------
// Chat Service — general-chat invariants (onlyjobs-78n Gap 2)
//   Contract: a GENERAL (non-job) send must use process.env.GPT_MODEL || "gpt-5-mini"
//   and must NOT inject a <job_match_context> block into the system prompt.
//   These assert the "additive-only / model unchanged" guarantee directly
//   rather than relying on code review.
// ---------------------------------------------------------------------------

describe('chatService general-chat invariants', () => {
  it('uses process.env.GPT_MODEL || "gpt-5-mini" for a general (non-job) send', async () => {
    await processMessage(testUserId.toString(), 'Hello, how can you help me?');

    // The main completion call (no tool calls in this simple path) is the first call.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as any;
    expect(callArgs.model).toBe(process.env.GPT_MODEL || 'gpt-5-mini');
  });

  it('system prompt does not contain <job_match_context> for a general (non-job) send', async () => {
    await processMessage(testUserId.toString(), 'Can you help me write a cover letter?');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as any;
    const systemMsg = (callArgs.messages as any[]).find((m: any) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    // Job context block is only injected for job-contextType conversations.
    // A fresh general conversation must never carry <job_match_context>.
    expect(systemMsg.content).not.toContain('<job_match_context>');
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
