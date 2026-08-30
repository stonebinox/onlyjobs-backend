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
import User from '../models/User';
import JobListing from '../models/JobListing';
import MatchRecord from '../models/MatchRecord';
import ChatConversation from '../models/ChatConversation';
import ChatMemory from '../models/ChatMemory';
import { processMessage } from '../services/chatService';
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
function uniqueEmail(tag: string): string {
  emailSeq++;
  return `chat-adv-${tag}-${emailSeq}-${testUserId.toHexString().slice(0, 8)}@example.com`;
}

beforeEach(() => {
  testUserId = new mongoose.Types.ObjectId();
  mockCreate = (MockOpenAI as any).__mockCreate as jest.Mock;
  mockCreate.mockClear();
  mockCreate.mockResolvedValue(defaultMockResponse);
});

// ---------------------------------------------------------------------------
// §1 MODEL — main completion call must use GPT_MODEL||"gpt-5-mini" and must
//            NOT carry temperature / top_p (gpt-5-mini rejects sampling params)
// ---------------------------------------------------------------------------

describe('§1 MODEL — completion call arguments', () => {
  it('uses process.env.GPT_MODEL when set', async () => {
    const origModel = process.env.GPT_MODEL;
    process.env.GPT_MODEL = 'gpt-adversarial-model-sentinel';
    try {
      await processMessage(testUserId.toString(), 'Hello');
    } finally {
      if (origModel === undefined) delete process.env.GPT_MODEL;
      else process.env.GPT_MODEL = origModel;
    }

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as any;
    expect(callArgs.model).toBe('gpt-adversarial-model-sentinel');
  });

  it('falls back to "gpt-5-mini" when GPT_MODEL env var is absent', async () => {
    const origModel = process.env.GPT_MODEL;
    delete process.env.GPT_MODEL;
    try {
      await processMessage(testUserId.toString(), 'Hello');
    } finally {
      if (origModel !== undefined) process.env.GPT_MODEL = origModel;
    }

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as any;
    expect(callArgs.model).toBe('gpt-5-mini');
  });

  it('NO temperature key in the main completion call (gpt-5-mini rejects it)', async () => {
    await processMessage(testUserId.toString(), 'Tell me about myself');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as any;
    expect(callArgs).not.toHaveProperty('temperature');
  });

  it('NO top_p key in the main completion call', async () => {
    await processMessage(testUserId.toString(), 'What are my strengths?');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as any;
    expect(callArgs).not.toHaveProperty('top_p');
  });

  it('no sampling parameters on ANY completion call during a message cycle', async () => {
    await processMessage(testUserId.toString(), 'Help me draft a cover letter');

    for (const [i, call] of mockCreate.mock.calls.entries()) {
      const args = call[0] as any;
      expect(args).not.toHaveProperty('temperature');
      expect(args).not.toHaveProperty('top_p');
      expect(args).not.toHaveProperty('frequency_penalty');
      expect(args).not.toHaveProperty('presence_penalty');
      void i; // suppress unused-var lint
    }
  });
});

// ---------------------------------------------------------------------------
// §2 ANTI-FABRICATION — system message must contain explicit grounding /
//    honesty instructions telling the model not to invent profile details
// ---------------------------------------------------------------------------

describe('§2 ANTI-FABRICATION — grounding instructions in system message', () => {
  it('system message contains anti-fabrication / grounding language', async () => {
    await processMessage(testUserId.toString(), 'Tell me about my career');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    expect(sys).toBeDefined();

    // Contract: forbids inventing career/company facts, tells model to ask when detail missing
    expect(sys.content).toMatch(/grounding|do not invent|not.*(in|present).*profile|ask/i);
  });

  it('grounding instruction is present even with a minimal profile (no resume, no Q&A)', async () => {
    const user = await User.create({
      email: uniqueEmail('noprofile'),
      password: 'hashed',
      name: 'Bare User',
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Draft a cover letter for me');

    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    expect(sys).toBeDefined();
    expect(sys.content).toMatch(/grounding|do not invent|not.*(in|present).*profile|ask/i);
  });
});

// ---------------------------------------------------------------------------
// §3 KEY REGRESSION — full Q&A injection for general (non-job) conversations.
//
//    Under the OLD keyword-retrieval the answer was only injected when the
//    user's message shared tokens with the question text.  After the fix, ALL
//    answered non-skipped Q&A is injected verbatim regardless of keyword match.
//
//    Test design: use the "preferred-ide" question
//      ("What is your preferred IDE and why?")
//    with a Fearn answer, and send a message about "small-team ownership" —
//    the question tokens (preferred, ide, why) share ZERO overlap with the
//    message tokens (draft, reply, application, prompt, small-team, ownership).
//    Under old keyword retrieval this answer would be dropped; full injection
//    must include it.
// ---------------------------------------------------------------------------

describe('§3 KEY REGRESSION — full Q&A injection regardless of keyword overlap', () => {
  it('[REGRESSION] Fearn answer injected even with zero keyword overlap (preferred-ide vs small-team ownership)', async () => {
    const DISTINCTIVE =
      'At Fearn I was the sole engineer alongside two non-technical co-founders, on a platform where users run bulk actions on thousands of records';

    const user = await User.create({
      email: uniqueEmail('fearn'),
      password: 'hashed',
      name: 'Fearn Engineer',
      resume: { skills: ['TypeScript'], summary: 'Solo engineer at early-stage startup' },
      qna: [
        // Question: "What is your preferred IDE and why?"
        // Tokens: preferred, ide, why
        // Message tokens: draft, reply, application, prompt, small-team, ownership
        // ZERO content-bearing overlap → old keyword retrieval drops this entry
        {
          questionId: 'preferred-ide',
          answer: DISTINCTIVE,
          mode: 'text',
          skipped: false,
        },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(
      testUserId.toString(),
      'Draft a reply for this application prompt about small-team ownership',
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    expect(sys).toBeDefined();
    const content: string = sys.content;

    // Full injection must include the answer verbatim
    expect(content).toContain(DISTINCTIVE);
    // Must be inside the Q&A framing
    expect(content).toContain('<user_qna_data>');
    expect(content).toContain('</user_qna_data>');
  });

  it('multiple answers injected verbatim even when neither question overlaps with the message', async () => {
    const MARK_A = 'ADVERSARIAL_MARK_ALPHA_unique9182_career_started';
    const MARK_B = 'ADVERSARIAL_MARK_BETA_unique7463_workplace_culture';

    const user = await User.create({
      email: uniqueEmail('multi-mark'),
      password: 'hashed',
      name: 'Marker User',
      resume: { skills: ['Go'] },
      qna: [
        // "How did you get started in your career?" — tokens: started, career — no overlap with IDE message
        { questionId: 'how-you-started', answer: MARK_A, mode: 'text', skipped: false },
        // "What do you value most in a workplace culture?" — tokens: value, workplace, culture — no overlap
        { questionId: 'workplace-culture-values', answer: MARK_B, mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    // "IDE configuration" — tokens: IDE, configuration — no overlap with career/workplace
    await processMessage(testUserId.toString(), 'What IDE configuration do you recommend for TypeScript?');

    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    const content: string = sys.content;

    expect(content).toContain(MARK_A);
    expect(content).toContain(MARK_B);
  });

  it('skipped entry answer text is absent from system prompt (skipped=true)', async () => {
    const SKIPPED_ANSWER = 'SKIPPED_ANSWER_MUST_NOT_APPEAR_unique5521';

    const user = await User.create({
      email: uniqueEmail('skipped-marker'),
      password: 'hashed',
      name: 'Skip Marker User',
      resume: { skills: ['Ruby'] },
      qna: [
        { questionId: 'your-story', answer: SKIPPED_ANSWER, mode: 'text', skipped: true },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Tell me your story about growing up');

    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    const content: string = sys.content;

    // Skipped answer must never appear
    expect(content).not.toContain(SKIPPED_ANSWER);
    // No Q&A block when only entry is skipped
    expect(content).not.toContain('<user_qna_data>');
  });

  it('empty-string answer (skipped=false) is not injected — treated as blank/unanswered', async () => {
    // Contract §3: "Skipped or empty answers are NOT injected."
    const user = await User.create({
      email: uniqueEmail('empty-ans'),
      password: 'hashed',
      name: 'Empty Ans User',
      resume: { skills: ['Python'] },
      qna: [
        { questionId: 'leadership-style', answer: '', mode: 'text', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'How would you describe your leadership style?');

    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    const content: string = sys.content;

    // Empty answer → no Q&A block injected
    expect(content).not.toContain('<user_qna_data>');
  });

  it('mixed: answered entry present; adjacent skipped entry absent', async () => {
    const ANSWERED_MARK = 'ANSWERED_CONTENT_XYZ_unique3847';
    const SKIPPED_MARK = 'SKIPPED_CONTENT_XYZ_unique2958';

    const user = await User.create({
      email: uniqueEmail('mixed'),
      password: 'hashed',
      name: 'Mixed User',
      resume: { skills: ['Rust'] },
      qna: [
        { questionId: 'your-story', answer: ANSWERED_MARK, mode: 'text', skipped: false },
        { questionId: 'fun-activities', answer: SKIPPED_MARK, mode: 'text', skipped: true },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Help me describe my IDE and tooling preferences');

    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    const content: string = sys.content;

    expect(content).toContain(ANSWERED_MARK);
    expect(content).not.toContain(SKIPPED_MARK);
    // Q&A block present because at least one answered entry exists
    expect(content).toContain('<user_qna_data>');
  });

  it('voice-transcribed answer is injected under full injection even with no keyword overlap', async () => {
    const VOICE_MARK = 'VOICE_ANSWER_UNIQUE_8821: I built a distributed load balancer in Go for fun';

    const user = await User.create({
      email: uniqueEmail('voice-mark'),
      password: 'hashed',
      name: 'Voice Mark User',
      resume: { skills: ['Go'] },
      qna: [
        // "What are your salary expectations?" — tokens: salary, expectations — no overlap with IDE message
        { questionId: 'salary-expectations', answer: VOICE_MARK, mode: 'voice', skipped: false },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Draft a cover letter talking about my IDE setup');

    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    const content: string = sys.content;

    // Voice answer must be injected regardless of keyword mismatch
    expect(content).toContain(VOICE_MARK);
  });
});

// ---------------------------------------------------------------------------
// §4 JOB CONVERSATIONS — keyword-relevance retrieval, NOT full injection.
//    An answered Q&A with zero keyword overlap with the job message must NOT
//    appear in the system prompt for a job conversation.
// ---------------------------------------------------------------------------

describe('§4 JOB CONVERSATIONS — keyword-relevance (not full injection)', () => {
  // Inline helpers matching the pattern from chat.job.test.ts
  async function makeJobChatUser() {
    emailSeq++;
    return User.create({
      _id: testUserId,
      name: 'Job Chat Adversarial',
      email: `chat-adv-jobconv-${emailSeq}-${Date.now()}@example.com`,
      password: 'hashed',
      isVerified: true,
      resume: { summary: 'Engineer', skills: ['TypeScript'], experience: [], education: [] },
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
      qna: [
        // "What do you do for fun?" — tokens: fun — zero overlap with the job message
        {
          questionId: 'fun-activities',
          answer: 'JOB_CONV_UNRELATED_ANSWER_unique8847: I enjoy competitive archery and building model ships as hobbies',
          mode: 'text',
          skipped: false,
        },
      ],
    });
  }

  async function makeJobListing() {
    return JobListing.create({
      title: 'Senior TypeScript Engineer',
      company: 'TechCorp',
      location: ['Remote'],
      tags: ['remote'],
      source: 'linkedin',
      description: 'Build backend APIs with Node.js and TypeScript.',
      url: 'https://techcorp.example.com/jobs/adv-test-1',
      salary: { min: 100000, max: 150000, currency: 'USD' },
      postedDate: new Date('2026-08-01'),
    });
  }

  async function makeMatchRecord(jobId: mongoose.Types.ObjectId) {
    return MatchRecord.create({
      userId: testUserId,
      jobId,
      matchScore: 78,
      verdict: 'Good Match',
      reasoning: 'Strong TypeScript and Node.js skills.',
      freshness: 'Fresh',
      skipped: false,
      applied: null,
    });
  }

  it('unrelated Q&A answer absent from job conversation system prompt (keyword-relevance, not full injection)', async () => {
    await makeJobChatUser();
    const job = await makeJobListing();
    const match = await makeMatchRecord(job._id as mongoose.Types.ObjectId);

    // Create job conversation via the upsert endpoint
    const upsertRes = await request(testApp)
      .post('/api/chat/conversations')
      .send({ contextType: 'job', contextMatchId: String(match._id) });
    expect(upsertRes.status).toBe(200);
    const { conversationId } = upsertRes.body;

    // Message with NO overlap with "fun", "activities", "archery", "model", "ships"
    const msgRes = await request(testApp)
      .post('/api/chat')
      .send({ message: 'What does this engineering position involve?', conversationId });

    expect(msgRes.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const callArgs = mockCreate.mock.calls[0][0];
    const sys = (callArgs.messages as any[]).find((m: any) => m.role === 'system');
    expect(sys).toBeDefined();
    const content: string = sys.content;

    // Job context must be present
    expect(content).toContain('<job_match_context>');
    expect(content).toContain('Senior TypeScript Engineer');

    // The fun-activities answer must NOT appear — job conversations use keyword-relevance, not full injection.
    // If full injection was mistakenly applied to job convs, this assertion fails → FINDING.
    expect(content).not.toContain('JOB_CONV_UNRELATED_ANSWER_unique8847');
    expect(content).not.toContain('competitive archery and building model ships');
  });
});

// ---------------------------------------------------------------------------
// §5 RATE LIMIT — 429 body must explicitly state "50 messages per hour",
//    not a stale "20" limit, and must apply at exactly 50 messages/hour.
// ---------------------------------------------------------------------------

describe('§5 RATE LIMIT — 429 response copy', () => {
  it('returns HTTP 429 when exactly 50 user messages sent within the past hour', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i}`,
      createdAt: new Date(),
    }));
    await ChatConversation.create({ userId: testUserId, title: 'Rate limit test', messages });

    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: 'One more message' });

    expect(res.status).toBe(429);
  });

  it('429 error body mentions "50" — not a stale "20" limit', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `Msg ${i}`,
      createdAt: new Date(),
    }));
    await ChatConversation.create({ userId: testUserId, title: 'Rate limit body test', messages });

    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: 'Over the limit' });

    expect(res.status).toBe(429);
    const body = res.body as { error?: string };
    expect(body.error).toBeDefined();
    // Contract §5: error must state 50, not a stale 20
    expect(body.error).toMatch(/50/);
    expect(body.error).not.toMatch(/\b20\b/);
    // Must mention time window
    expect(body.error).toMatch(/hour/i);
  });

  it('49 messages within the past hour does NOT trigger rate limit', async () => {
    const messages = Array.from({ length: 49 }, (_, i) => ({
      role: 'user' as const,
      content: `Msg ${i}`,
      createdAt: new Date(),
    }));
    await ChatConversation.create({ userId: testUserId, title: 'Under limit', messages });

    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: 'Still within the limit' });

    expect(res.status).toBe(200);
  });

  it('50 messages older than one hour do NOT trigger rate limit (sliding window, not total count)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `Old msg ${i}`,
      createdAt: twoHoursAgo,
    }));
    await ChatConversation.create({ userId: testUserId, title: 'Old messages', messages });

    const res = await request(testApp)
      .post('/api/chat')
      .send({ message: 'This is new and should succeed' });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §6 BUDGET/DROP — when Q&A answers exceed ~120000 chars total, older entries
//    are dropped with a VISIBLE omission note (not silently removed).
//    Per-answer cap: 2000 chars. Each entry contributes ~2017 chars to totalChars.
//    Seeding 65 answers × 2000 chars ≈ 130 000 chars > 120 000-char budget.
// ---------------------------------------------------------------------------

describe('§6 BUDGET/DROP — omission note for oversized Q&A block', () => {
  it('emits a visible omission note when answered Q&A exceeds the total budget', async () => {
    // 65 answers × 2000 chars ≈ 130 000 chars > 120 000-char budget.
    // Per-answer cap is 2000 chars; answers at exactly the cap are NOT truncated,
    // so each contributes ~2017 chars to the running total (entry + "\n\n" separator).
    // With 65 entries, the budget overflows at entry ~60 → trailing entries dropped.
    const PER_ANSWER_CHARS = 2000;
    const NUM_ENTRIES = 65;
    const qnaEntries = Array.from({ length: NUM_ENTRIES }, (_, i) => ({
      questionId: `q-budget-${i}`,
      // Distinct marker prefix + padding to reach PER_ANSWER_CHARS
      answer: `BUDGET_ENTRY_${i}_${'B'.repeat(PER_ANSWER_CHARS - `BUDGET_ENTRY_${i}_`.length)}`,
      mode: 'text' as const,
      skipped: false,
    }));

    const user = await User.create({
      email: uniqueEmail('budget'),
      password: 'hashed',
      name: 'Budget User',
      resume: { skills: ['Go'] },
      qna: qnaEntries,
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Show me all my answers please');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    expect(sys).toBeDefined();
    const content: string = sys.content;

    // 1. Q&A block present
    expect(content).toContain('<user_qna_data>');

    // 2. Visible omission note — entries were dropped, not silently
    expect(content).toMatch(/omit|drop|not shown|additional|more.*question|not.*all|remaining/i);

    // 3. Not all 15 entries appear (budget exceeded → some dropped)
    const appearedIndices = Array.from({ length: NUM_ENTRIES }, (_, i) => i)
      .filter(i => content.includes(`BUDGET_ENTRY_${i}_`));
    expect(appearedIndices.length).toBeLessThan(NUM_ENTRIES);

    // 4. Entries that DO appear are complete (no silent mid-answer truncation)
    for (const i of appearedIndices) {
      expect(content).toContain(qnaEntries[i].answer);
    }

    // 5. At least some entries appeared at all
    if (appearedIndices.length === 0) {
      throw new Error(
        'No budget entries appeared in the system prompt — implementation may have silently dropped everything without an omission note',
      );
    }
  });

  it('under-budget block shows NO omission note and all entries present', async () => {
    // 10 answers × 350 chars ≈ 3 500 chars — well under 120 000
    const answers = Array.from({ length: 10 }, (_, i) => ({
      questionId: `q-small-${i}`,
      answer: `SMALL_ENTRY_${i}_${'S'.repeat(350 - `SMALL_ENTRY_${i}_`.length)}`,
      mode: 'text' as const,
      skipped: false,
    }));

    const user = await User.create({
      email: uniqueEmail('small-budget'),
      password: 'hashed',
      name: 'Small Budget User',
      resume: { skills: ['JS'] },
      qna: answers,
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Tell me about my experience and background');

    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    const content: string = sys.content;

    // All 10 entries present (under budget)
    for (let i = 0; i < 10; i++) {
      expect(content).toContain(`SMALL_ENTRY_${i}_`);
    }
  });
});

// ---------------------------------------------------------------------------
// §6b REALISTIC BUDGET — a realistic full answered set (40 answers × ~500 chars)
//     is fully injected with NO omission note, and a distinctive sentence from
//     the LAST answer is present (proving later answers are not dropped at the
//     old 24000-char boundary).
// ---------------------------------------------------------------------------

describe('§6b REALISTIC BUDGET — full answered set injected without omission', () => {
  it('40 answers × ~500 chars fully injected; last-answer marker present; no omission note', async () => {
    const NUM_ANSWERS = 40;
    const PER_ANSWER = 500;
    // Total ≈ 20 000 chars — well under the 120 000-char budget
    const LAST_ANSWER_MARK =
      'LAST_ANSWER_DISTINCTIVE_unique4492_deployed_realtime_event_streaming_pipeline_iot_telemetry';

    const answers = Array.from({ length: NUM_ANSWERS }, (_, i) => {
      if (i === NUM_ANSWERS - 1) {
        const padding = 'R'.repeat(Math.max(0, PER_ANSWER - LAST_ANSWER_MARK.length - 1));
        return { questionId: `q-realistic-${i}`, answer: `${LAST_ANSWER_MARK} ${padding}`, mode: 'text' as const, skipped: false };
      }
      const prefix = `REALISTIC_ENTRY_${i}_`;
      return {
        questionId: `q-realistic-${i}`,
        answer: `${prefix}${'R'.repeat(Math.max(0, PER_ANSWER - prefix.length))}`,
        mode: 'text' as const,
        skipped: false,
      };
    });

    const user = await User.create({
      email: uniqueEmail('realistic-full'),
      password: 'hashed',
      name: 'Realistic Full User',
      resume: { skills: ['TypeScript'] },
      qna: answers,
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    await processMessage(testUserId.toString(), 'Tell me about my background and experience');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    expect(sys).toBeDefined();
    const content: string = sys.content;

    // Q&A block present
    expect(content).toContain('<user_qna_data>');

    // All 40 entries fully present — no budget drop
    for (let i = 0; i < NUM_ANSWERS; i++) {
      expect(content).toContain(answers[i].answer.slice(0, 30));
    }

    // Distinctive last-answer marker present — proves last entry not dropped at old 24 000 boundary
    expect(content).toContain(LAST_ANSWER_MARK);

    // No omission note — everything fit under the 120 000-char budget
    expect(content).not.toMatch(/omit|drop|not shown|additional.*question|remaining.*question/i);
  });
});

// ---------------------------------------------------------------------------
// §7 DATA PRECEDENCE — the system prompt must instruct the model that current
//    profile/Q&A data is authoritative and OUTRANKS saved memory entries when
//    they conflict.  We seed a user whose current Q&A contains a distinctive
//    true fact and whose ChatMemory holds a contradictory entry.  We then
//    assert that:
//      (a) the Q&A fact reaches the system prompt (in <user_qna_data>),
//      (b) the contradictory memory value also reaches the system prompt
//          (memory is still injected — we are not asserting it's hidden),
//      (c) the system prompt contains explicit precedence/authority language
//          telling the model to trust current profile data over saved memory /
//          earlier summaries when they conflict.
// ---------------------------------------------------------------------------

describe('§7 DATA PRECEDENCE — current Q&A outranks contradictory saved memory', () => {
  it('system prompt carries Q&A fact, contradictory memory, AND explicit precedence language', async () => {
    // A distinctive fact present in current Q&A
    const QNA_FACT =
      'At Fearn I was the sole engineer alongside two non-technical co-founders on a platform for bulk operations on thousands of records';

    // A contradictory claim stored in ChatMemory
    const MEMORY_CONTRADICTION = 'Fearn is a healthcare hiring marketplace';

    const user = await User.create({
      email: uniqueEmail('precedence'),
      password: 'hashed',
      name: 'Precedence Test User',
      resume: { skills: ['TypeScript'], summary: 'Solo engineer at Fearn' },
      qna: [
        {
          questionId: 'preferred-ide',
          answer: QNA_FACT,
          mode: 'text',
          skipped: false,
        },
      ],
    });
    testUserId = user._id as mongoose.Types.ObjectId;

    // Seed contradictory memory for this user
    await ChatMemory.create({
      userId: testUserId,
      entries: [
        {
          key: 'company_fearn',
          value: MEMORY_CONTRADICTION,
          source: 'test-seed',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    await processMessage(testUserId.toString(), 'Tell me about my work experience');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const msgs = mockCreate.mock.calls[0][0].messages as any[];
    const sys = msgs.find((m: any) => m.role === 'system');
    expect(sys).toBeDefined();
    const content: string = sys.content;

    // (a) Current Q&A fact is present — inside <user_qna_data>
    expect(content).toContain('<user_qna_data>');
    expect(content).toContain(QNA_FACT);

    // (b) Contradictory memory value is also present (memory still injected)
    expect(content).toContain(MEMORY_CONTRADICTION);

    // (c) Explicit precedence language instructs the model to trust current profile/Q&A
    //     over saved memory / earlier summaries when they conflict.
    //
    //     Two assertions required — the old single regex matched "authoritative" from an
    //     UNRELATED guardrail bullet ("their correction is authoritative"), so the §7
    //     data-precedence bullets could be deleted and the test still passed.
    //
    //     (c1) "source of truth" appears ONLY in the data-precedence bullet, not in the
    //          unrelated guardrail — so this guards the first bullet specifically.
    //     (c2) A memory-precedence phrase from the second bullet — confirms the "saved
    //          memory / summaries may be outdated, disregard the stale claim" instruction
    //          is also present.
    expect(content).toMatch(/source of truth/i);
    expect(content).toMatch(/saved memory|earlier-conversation summar|outdated|disregard the stale|trust the current profile/i);
  });
});

// ---------------------------------------------------------------------------
// DISCLOSURE
// Files read (beyond the mock/helper patterns explicitly allowed in the brief):
//   - src/__tests__/chat.test.ts           (allowed: mock setup, model shapes, processMessage usage)
//   - src/__tests__/chat.job.test.ts       (read to learn job-conversation helper pattern and HTTP stack)
//   - src/__tests__/setup.ts               (MongoDB memory server setup — wiring only)
//   - src/models/User.ts                   (model shape — qna field, IUser interface)
//   - src/models/ChatConversation.ts       (model shape — contextType field)
//   - src/models/MatchRecord.ts            (model shape — for job-conversation helpers, first 60 lines)
//   - src/utils/questions.ts              (question catalog — to confirm which questionId maps to which text)
//   - src/types/Question.ts               (type definition only)
//   - src/types/AnsweredQuestion.ts        (type definition only)
//   - src/routes/chatRoutes.ts             (grep ^router. only — route paths)
//   - src/controllers/chatController.ts    (grep 429|rate|50 — confirmed "50 messages per hour" copy)
//   - src/services/chatService.ts          (grep ^export only — line numbers and function names, NO body)
//   - jest.config.ts                       (test configuration)
//
// None of these reads revealed the chatService implementation body.
// The chatService grep showed only export statement line numbers (851, 1023).
// No implementation logic was incidentally observed.
//
// The 429 error body copy "Rate limit exceeded. Maximum 50 messages per hour."
// was read from the controller, not the service — this informed §5's exact
// regex. No service implementation logic was exposed by that grep.
// ---------------------------------------------------------------------------
