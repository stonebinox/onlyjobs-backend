// OpenAI mock must be declared before importing chatService
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

import OpenAI from 'openai';
import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import ChatConversation from '../models/ChatConversation';
import ChatMemory from '../models/ChatMemory';
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
  mockCreate = jest.fn().mockResolvedValue(defaultMockResponse);
  MockOpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
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

  it('returns false when at 20 messages in the last hour', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
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
    const messages = Array.from({ length: 20 }, (_, i) => ({
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
