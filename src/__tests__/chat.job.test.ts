// OpenAI mock must be declared before any chatService import
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
import User from '../models/User';
import JobListing from '../models/JobListing';
import MatchRecord from '../models/MatchRecord';
import ChatConversation from '../models/ChatConversation';
import chatRoutes from '../routes/chatRoutes';

const MockOpenAI = OpenAI as unknown as jest.Mock;

let testUserId: mongoose.Types.ObjectId;
let mockCreate: jest.Mock;

const defaultMockResponse = {
  choices: [{
    message: { role: 'assistant' as const, content: 'AI reply', tool_calls: undefined },
    finish_reason: 'stop' as const,
  }],
};

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

let emailSeq = 0;

async function makeUser() {
  emailSeq++;
  return User.create({
    _id: testUserId,
    name: 'Job Chat Tester',
    email: `job-chat-${emailSeq}-${Date.now()}@example.com`,
    password: 'hashed',
    isVerified: true,
    resume: { summary: 'Engineer', skills: ['JS'], experience: [], education: [] },
    preferences: {
      matchingEnabled: true,
      remoteOnly: false,
      minSalary: 0,
      location: [],
      jobTypes: [],
      industries: [],
      minScore: 30,
    },
    walletBalance: 1.00,
    skippedJobs: [],
  });
}

async function makeJob() {
  return JobListing.create({
    title: 'Senior Engineer',
    company: 'Acme Corp',
    location: ['Remote'],
    tags: ['remote'],
    source: 'linkedin',
    description: 'Build great things at Acme. We love TypeScript.',
    url: 'https://acme.example.com/jobs/123',
    salary: { min: 120000, max: 160000, currency: 'USD' },
    postedDate: new Date('2026-08-01'),
  });
}

async function makeMatch(jobId: mongoose.Types.ObjectId, overrides: Record<string, any> = {}) {
  return MatchRecord.create({
    userId: testUserId,
    jobId,
    matchScore: 82,
    verdict: 'Strong Match',
    reasoning: 'Great TypeScript skills align well.',
    freshness: 'Fresh',
    skipped: false,
    applied: null,
    ...overrides,
  });
}

beforeEach(() => {
  testUserId = new mongoose.Types.ObjectId();
  mockCreate = (MockOpenAI as any).__mockCreate as jest.Mock;
  mockCreate.mockClear();
  mockCreate.mockResolvedValue(defaultMockResponse);
});

// ---------------------------------------------------------------------------
// Smoke test 1: Creating a job conversation for own match returns conversationId
// ---------------------------------------------------------------------------

describe('POST /api/chat/conversations — job conversation upsert', () => {
  it('returns conversationId and empty messages for own match', async () => {
    await makeUser();
    const job = await makeJob();
    const match = await makeMatch(job._id as mongoose.Types.ObjectId);

    const res = await request(testApp)
      .post('/api/chat/conversations')
      .send({ contextType: 'job', contextMatchId: String(match._id) });

    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBeDefined();
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.messages).toHaveLength(0);
  });

  it('returns the SAME conversationId on repeated calls (idempotent)', async () => {
    await makeUser();
    const job = await makeJob();
    const match = await makeMatch(job._id as mongoose.Types.ObjectId);

    const res1 = await request(testApp)
      .post('/api/chat/conversations')
      .send({ contextType: 'job', contextMatchId: String(match._id) });

    const res2 = await request(testApp)
      .post('/api/chat/conversations')
      .send({ contextType: 'job', contextMatchId: String(match._id) });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.conversationId).toBe(res2.body.conversationId);
  });

  it('returns 404 for a matchId that belongs to another user', async () => {
    await makeUser();
    const job = await makeJob();
    const foreignUserId = new mongoose.Types.ObjectId();
    const foreignMatch = await MatchRecord.create({
      userId: foreignUserId,
      jobId: job._id,
      matchScore: 70,
      verdict: 'Good Match',
      reasoning: 'Decent fit.',
      freshness: 'Fresh',
      skipped: false,
      applied: null,
    });

    const res = await request(testApp)
      .post('/api/chat/conversations')
      .send({ contextType: 'job', contextMatchId: String(foreignMatch._id) });

    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid ObjectId', async () => {
    const res = await request(testApp)
      .post('/api/chat/conversations')
      .send({ contextType: 'job', contextMatchId: 'not-an-objectid' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when contextType is not job', async () => {
    const res = await request(testApp)
      .post('/api/chat/conversations')
      .send({ contextType: 'general', contextMatchId: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Smoke test 2: Sending a message on a job conversation injects the job context block
// ---------------------------------------------------------------------------

describe('POST /api/chat — message on job conversation injects job context', () => {
  it('includes job_match_context block in the system prompt sent to OpenAI', async () => {
    await makeUser();
    const job = await makeJob();
    const match = await makeMatch(job._id as mongoose.Types.ObjectId);

    // Create job conversation
    const upsertRes = await request(testApp)
      .post('/api/chat/conversations')
      .send({ contextType: 'job', contextMatchId: String(match._id) });
    expect(upsertRes.status).toBe(200);
    const { conversationId } = upsertRes.body;

    // Send a message
    const msgRes = await request(testApp)
      .post('/api/chat')
      .send({ message: 'Am I a good fit for this role?', conversationId });

    expect(msgRes.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const callArgs = mockCreate.mock.calls[0][0];
    const systemMsg = callArgs.messages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    const content: string = systemMsg.content;

    // Must contain the job context block
    expect(content).toContain('<job_match_context>');
    expect(content).toContain('</job_match_context>');

    // Must contain instruction guard
    expect(content).toContain('REFERENCE DATA');

    // Must contain job fields loaded server-side
    expect(content).toContain('Senior Engineer');
    expect(content).toContain('Acme Corp');
    expect(content).toContain('Build great things at Acme');

    // Must contain match fields
    expect(content).toContain('82/100');
    expect(content).toContain('Strong Match');
    expect(content).toContain('Great TypeScript skills align well.');

    // Job context must appear AFTER user_profile_data and BEFORE user_qna_data
    const profileIdx = content.indexOf('<user_profile_data>');
    const jobIdx = content.indexOf('<job_match_context>');
    const qnaIdx = content.indexOf('<user_qna_data>');
    // Profile before job context
    if (profileIdx !== -1) expect(profileIdx).toBeLessThan(jobIdx);
    // Job context before Q&A (if Q&A present)
    if (qnaIdx !== -1) expect(jobIdx).toBeLessThan(qnaIdx);
  });

  it('handles deleted job listing gracefully — still renders match context', async () => {
    await makeUser();
    const job = await makeJob();
    const match = await makeMatch(job._id as mongoose.Types.ObjectId);

    const upsertRes = await request(testApp)
      .post('/api/chat/conversations')
      .send({ contextType: 'job', contextMatchId: String(match._id) });
    const { conversationId } = upsertRes.body;

    // Delete the job listing
    await JobListing.deleteOne({ _id: job._id });

    const msgRes = await request(testApp)
      .post('/api/chat')
      .send({ message: 'Tell me about this role', conversationId });

    expect(msgRes.status).toBe(200);
    const callArgs = mockCreate.mock.calls[0][0];
    const systemMsg = callArgs.messages.find((m: any) => m.role === 'system');
    const content: string = systemMsg.content;

    expect(content).toContain('<job_match_context>');
    expect(content).toContain('no longer available');
    // Match data still rendered
    expect(content).toContain('82/100');
  });
});

// ---------------------------------------------------------------------------
// Smoke test 3: Foreign matchId on message send → 404, no OpenAI call
// ---------------------------------------------------------------------------

describe('POST /api/chat — ownership revalidation on every send', () => {
  it('returns 404 and makes no OpenAI call when contextMatchId is tampered post-creation', async () => {
    await makeUser();
    const job = await makeJob();
    const foreignUserId = new mongoose.Types.ObjectId();

    // Create a job conversation directly with a foreign match (simulating tamper)
    const foreignMatch = await MatchRecord.create({
      userId: foreignUserId,
      jobId: job._id,
      matchScore: 55,
      verdict: 'Weak Match',
      reasoning: 'Not great.',
      freshness: 'Fresh',
      skipped: false,
      applied: null,
    });

    const tamperedConv = await ChatConversation.create({
      userId: testUserId,
      contextType: 'job',
      contextMatchId: foreignMatch._id,
      title: '',
      messages: [],
    });

    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: 'Tell me about this job', conversationId: String(tamperedConv._id) });

    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Smoke test 4: General chat path is completely unchanged
// ---------------------------------------------------------------------------

describe('POST /api/chat — general chat unaffected', () => {
  it('general chat still works and does NOT include job_match_context', async () => {
    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: 'Hello, help me with my profile' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('AI reply');
    expect(res.body.conversationId).toBeDefined();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    const systemMsg = callArgs.messages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).not.toContain('<job_match_context>');
    expect(systemMsg.content).not.toContain('</job_match_context>');
  });

  it('general chat continues to work with a valid conversationId', async () => {
    const conv = await ChatConversation.create({
      userId: testUserId,
      contextType: 'general',
      title: 'My chat',
      messages: [],
    });

    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: 'What is my top skill?', conversationId: String(conv._id) });

    expect(res.status).toBe(200);
    const callArgs = mockCreate.mock.calls[0][0];
    const systemMsg = callArgs.messages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).not.toContain('<job_match_context>');
  });
});
