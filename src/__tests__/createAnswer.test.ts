// OpenAI mock must be declared before importing modules that use it
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed'),
  compare: jest.fn().mockResolvedValue(true),
}));

import OpenAI from 'openai';
import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import MatchRecord from '../models/MatchRecord';
import User from '../models/User';
import userRoutes from '../routes/userRoutes';
import { getAnswerComposerInstructions } from '../utils/getAnswerComposerInstructions';

const MockOpenAI = OpenAI as unknown as jest.Mock;

let testUserId: mongoose.Types.ObjectId;
let mockCreate: jest.Mock;

const buildMockOpenAIResponse = (content: string) => ({
  choices: [
    {
      message: { role: 'assistant' as const, content, tool_calls: undefined },
      finish_reason: 'stop' as const,
    },
  ],
});

// Build test app
const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.user = { id: testUserId.toString(), _id: testUserId };
  next();
});
testApp.use('/api/users', userRoutes);
testApp.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const status = res.statusCode !== 200 ? res.statusCode : 500;
    res.status(status).json({ error: err.message });
  }
);

beforeEach(() => {
  testUserId = new mongoose.Types.ObjectId();
  mockCreate = jest
    .fn()
    .mockResolvedValue(buildMockOpenAIResponse('Generated answer text'));
  MockOpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

// ---------------------------------------------------------------------------
// Helper: create a real User document
// ---------------------------------------------------------------------------
async function createTestUser(id: mongoose.Types.ObjectId) {
  return User.create({
    _id: id,
    name: 'Test User',
    email: `test-${id}@example.com`,
    password: 'hashed',
    isVerified: true,
    qna: [],
  });
}

// ---------------------------------------------------------------------------
// Helper: create a MatchRecord
// ---------------------------------------------------------------------------
async function createMatchRecord(
  userId: mongoose.Types.ObjectId,
  qna: Array<{ question: string; answer: string; createdAt: Date }> = []
) {
  const jobId = new mongoose.Types.ObjectId();
  return MatchRecord.create({
    userId,
    jobId,
    matchScore: 80,
    verdict: 'Good match',
    reasoning: 'Test',
    qna,
  });
}

// ---------------------------------------------------------------------------
// Ownership enforcement
// ---------------------------------------------------------------------------

describe('POST /api/users/create-answer — ownership', () => {
  it('returns 403 when MatchRecord.userId does not match req.user.id', async () => {
    const otherUserId = new mongoose.Types.ObjectId();
    await createTestUser(testUserId);
    await createTestUser(otherUserId);
    const matchRecord = await createMatchRecord(otherUserId);

    const res = await request(testApp)
      .post('/api/users/create-answer')
      .send({ question: 'What is your experience?', jobResultId: (matchRecord._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(403);
    expect(res.body.message || res.body.error).toMatch(/forbidden/i);
  });
});

// ---------------------------------------------------------------------------
// customInstructions length handling
// ---------------------------------------------------------------------------

describe('POST /api/users/create-answer — customInstructions', () => {
  it('accepts customInstructions longer than 500 chars (truncated silently, not rejected)', async () => {
    await createTestUser(testUserId);
    const longInstructions = 'a'.repeat(600);

    const res = await request(testApp)
      .post('/api/users/create-answer')
      .send({ question: 'Tell me about yourself', customInstructions: longInstructions });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.answer).toBe('Generated answer text');

    // Verify the prompt sent to OpenAI contains exactly the first 500 chars, not the full 600
    const systemPrompt: string = mockCreate.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain('a'.repeat(500));
    expect(systemPrompt).not.toContain('a'.repeat(501));
  });
});

// ---------------------------------------------------------------------------
// regenerate semantics
// ---------------------------------------------------------------------------

describe('POST /api/users/create-answer — regenerate', () => {
  it('regenerate: true with a prior matching entry replaces it (no duplicate)', async () => {
    await createTestUser(testUserId);
    const question = 'What is your greatest strength?';
    const matchRecord = await createMatchRecord(testUserId, [
      { question, answer: 'Original answer', createdAt: new Date() },
    ]);

    mockCreate.mockResolvedValue(buildMockOpenAIResponse('Regenerated answer'));

    const res = await request(testApp)
      .post('/api/users/create-answer')
      .send({
        question,
        jobResultId: (matchRecord._id as mongoose.Types.ObjectId).toString(),
        regenerate: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Regenerated answer');

    const updated = await MatchRecord.findById(matchRecord._id as mongoose.Types.ObjectId);
    const qnaForQuestion = updated!.qna!.filter((q) => q.question === question);
    expect(qnaForQuestion).toHaveLength(1);
    expect(qnaForQuestion[0].answer).toBe('Regenerated answer');
  });

  it('regenerate: true with multiple matching entries replaces only the most recent one', async () => {
    await createTestUser(testUserId);
    const question = 'Describe a challenge you overcame.';
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const matchRecord = await createMatchRecord(testUserId, [
      { question, answer: 'old answer', createdAt: oneHourAgo },
      { question, answer: 'latest answer', createdAt: tenMinutesAgo },
    ]);

    mockCreate.mockResolvedValue(buildMockOpenAIResponse('Fresh regenerated answer'));

    const res = await request(testApp)
      .post('/api/users/create-answer')
      .send({
        question,
        jobResultId: (matchRecord._id as mongoose.Types.ObjectId).toString(),
        regenerate: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Fresh regenerated answer');

    const updated = await MatchRecord.findById(matchRecord._id as mongoose.Types.ObjectId);
    const qnaForQuestion = updated!.qna!.filter((q) => q.question === question);

    // Total length unchanged — no append
    expect(qnaForQuestion).toHaveLength(2);

    // Most recent entry (was 'latest answer') got replaced
    const sortedByDate = [...qnaForQuestion].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    expect(sortedByDate[0].answer).toBe('Fresh regenerated answer');

    // Older entry is unchanged
    expect(sortedByDate[1].answer).toBe('old answer');
  });

  it('regenerate: true with no prior matching entry appends (fallback)', async () => {
    await createTestUser(testUserId);
    const question = 'What is your greatest weakness?';
    const matchRecord = await createMatchRecord(testUserId);

    mockCreate.mockResolvedValue(buildMockOpenAIResponse('New answer'));

    const res = await request(testApp)
      .post('/api/users/create-answer')
      .send({
        question,
        jobResultId: (matchRecord._id as mongoose.Types.ObjectId).toString(),
        regenerate: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('New answer');

    const updated = await MatchRecord.findById(matchRecord._id as mongoose.Types.ObjectId);
    expect(updated!.qna).toHaveLength(1);
    expect(updated!.qna![0].question).toBe(question);
    expect(updated!.qna![0].answer).toBe('New answer');
  });
});

// ---------------------------------------------------------------------------
// Prompt content — anti-AI rules and customInstructions injection
// ---------------------------------------------------------------------------

describe('getAnswerComposerInstructions prompt content', () => {
  it('contains anti-AI hard-ban rules', () => {
    const prompt = getAnswerComposerInstructions([], {});
    expect(prompt).toContain('em dashes');
    expect(prompt).toContain('bullet');
    expect(prompt).toContain('utilize');
    expect(prompt).toContain('delve');
    expect(prompt).toContain('leverage');
    expect(prompt).toContain('ATS');
  });

  it('injects customInstructions as a distinct section', () => {
    const prompt = getAnswerComposerInstructions(
      [],
      {},
      null,
      undefined,
      'Keep it under 50 words.'
    );
    expect(prompt).toContain('Keep it under 50 words.');
    expect(prompt).toContain("User's custom instructions");
  });

  it('does not include customInstructions section when not provided', () => {
    const prompt = getAnswerComposerInstructions([], {});
    expect(prompt).not.toContain("User's custom instructions");
  });
});
