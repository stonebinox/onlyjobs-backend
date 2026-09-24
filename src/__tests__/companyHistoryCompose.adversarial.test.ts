/**
 * ADVERSARIAL tests covering two gaps found in code review:
 *
 * GAP 1  composeReasoningWithHistory sentence-cap (no existing adversarial coverage)
 * GAP 2  on-demand caller path (matchJobOnDemand) — existing caller tests mock the very seam
 *         under test (matchUserToJob), so DB history loading, company join, normalisation-in-
 *         caller, prompt injection, and the final persisted score/reasoning are all unverified.
 *
 * ORACLE: all expected values derived from the spec, never from observed runtime output.
 *
 * Spec weights:
 *   rejected -3 each; no_response -1 each, total no_response contribution capped at -2;
 *   heard_back +1; interview +3; offer +4.
 *   Sum clamped to [-5, +5].  Final score clamped [0, 100].
 *   Gate: (baseScore < minScore) must equal (adjustedScore < minScore); if nudge would cross
 *   the gate it is suppressed (adjustedScore = baseScore) but reasoningLine is still non-null.
 *
 * composeReasoningWithHistory spec:
 *   null / empty / whitespace historyLine → returns modelReasoning trimmed, unchanged.
 *   otherwise → at most the first 2 sentences of modelReasoning + historyLine as the final
 *   sentence.  Result: no newlines, no doubled periods, single spaces between sentences.
 *   Result is AT MOST 3 sentences.
 *
 * DISCLOSURE:
 *   Implementation bodies NOT read: normalizeCompanyName, buildCompanyHistoryMap,
 *   applyCompanyHistoryNudge, composeReasoningWithHistory in backend/src/utils/companyHistory.ts.
 *   Files read: jobController.ts (the caller under test), matchingService.ts (to understand the
 *   seam boundary), MatchRecord/User/JobListing models (schema fields), existing matching.test.ts
 *   (test-infrastructure patterns), setup.ts (MongoDB memory-server wiring), the smoke and
 *   adversarial test files for companyHistory utils (to see what is ALREADY covered).
 *   All numeric expected values trace to the spec weights reproduced above.
 */

// ── OpenAI mock — must precede all imports that transitively touch openai ──
const mockCreate = jest.fn();
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }))
);

jest.mock('../services/userService', () => ({
  getUserQnA: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/analyticsService', () => ({
  captureLifecycleEvent: jest.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────

import mongoose from 'mongoose';
import User from '../models/User';
import JobListing from '../models/JobListing';
import MatchRecord, { Freshness } from '../models/MatchRecord';
import Transaction from '../models/Transaction';
import { matchJobOnDemand } from '../controllers/jobController';
import { applyCompanyHistoryNudge, composeReasoningWithHistory } from '../utils/companyHistory';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a mock chat completion shaped exactly like the backend matchUserToJob parser expects.
 * The backend parser does `output.match(/\{[\s\S]*\}/)` then JSON.parse, so the JSON must be the
 * only content.
 */
function chatResponse(body: { matchScore: number; verdict: string; reasoning: string }) {
  return {
    choices: [{ message: { content: JSON.stringify(body) } }],
    // no usage field — backend matchUserToJob doesn't read it
  };
}

/**
 * Count sentences in a string using the spec-mandated pattern.
 * Split on /(?<=[.!?])\s+/ and count non-empty segments.
 */
function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0).length;
}

/**
 * Extract the userInfo object sent to OpenAI from a mockCreate call's args.
 * Message format: "User:\n{json}\n\nJob:\n{json}\n\nEvaluate this match."
 */
function extractUserInfoFromCreateCall(callArgs: any): Record<string, any> {
  const userMsg = callArgs.messages.find((m: any) => m.role === 'user');
  const match = userMsg.content.match(/User:\n([\s\S]*?)\n\nJob:/);
  if (!match) throw new Error('Could not find User section in OpenAI message content');
  return JSON.parse(match[1]);
}

/**
 * Invoke matchJobOnDemand (which is already wrapped in asyncHandler) with controlled req/res.
 * Returns { json: jest.fn() } whose first call arg is the response body.
 * Throws if the handler passes an error to next().
 *
 * asyncHandler always returns a resolved Promise (errors go to next, not rejection), so we
 * await it and check the capturedError afterward.
 */
async function invokeOnDemand(
  user: any,
  jobId: string
): Promise<{ json: jest.Mock }> {
  const jsonSpy = jest.fn();
  let capturedError: any = null;
  const req: any = { user, params: { jobId } };
  const res: any = {
    json: jsonSpy,
    status: jest.fn().mockReturnThis(),
  };
  const next = (err?: any) => { capturedError = err; };

  // asyncHandler(fn)(req, res, next) returns Promise.resolve(fn(req,res,next)).catch(next).
  // The .catch(next) swallows rejections so the returned promise ALWAYS fulfills.
  // await here waits for the entire async handler to finish.
  await (matchJobOnDemand as any)(req, res, next);

  if (capturedError) throw capturedError;
  return { json: jsonSpy };
}

// ─── GAP 1: composeReasoningWithHistory adversarial sentence-cap tests ────────

describe('composeReasoningWithHistory — adversarial sentence cap (GAP 1)', () => {
  // ── null / empty / whitespace historyLine: must return modelReasoning unchanged ──

  it('null historyLine returns modelReasoning trimmed, no trailing junk appended', () => {
    const result = composeReasoningWithHistory('One. Two.', null);
    expect(result).toBe('One. Two.');
    // extra guard: the string "null" or whitespace must not appear
    expect(result).not.toMatch(/null|undefined|\s+$/);
  });

  it('empty-string historyLine returns modelReasoning trimmed, no trailing space or punctuation added', () => {
    const result = composeReasoningWithHistory('  One. Two.  ', '');
    expect(result).toBe('One. Two.');
    expect(result).not.toMatch(/\.\s*$\s*\./);
  });

  it('whitespace-only historyLine returns modelReasoning trimmed, no trailing junk', () => {
    const result = composeReasoningWithHistory('One. Two.', '   ');
    expect(result).toBe('One. Two.');
    expect(result).not.toMatch(/\s+$/);
  });

  // ── sentence count is AT MOST 3 ──

  it('3-sentence modelReasoning + historyLine → result has EXACTLY 3 sentences, ends with historyLine', () => {
    const result = composeReasoningWithHistory(
      'First sentence. Second sentence. Third sentence.',
      'History note.'
    );
    const count = countSentences(result);
    expect(count).toBe(3);
    expect(result.trim().endsWith('History note.')).toBe(true);
  });

  it('5-sentence modelReasoning + historyLine → result has ≤3 sentences, ends with historyLine', () => {
    const result = composeReasoningWithHistory(
      'One. Two. Three. Four. Five.',
      'History note.'
    );
    const count = countSentences(result);
    expect(count).toBeLessThanOrEqual(3);
    expect(result.trim().endsWith('History note.')).toBe(true);
  });

  it('1-sentence modelReasoning + historyLine → 2 sentences, no doubled period, no double space', () => {
    const result = composeReasoningWithHistory('Just one sentence.', 'History note.');
    expect(countSentences(result)).toBe(2);
    expect(result).not.toMatch(/\.\./);
    expect(result).not.toMatch(/\s{2,}/);
    expect(result.trim().endsWith('History note.')).toBe(true);
  });

  it('modelReasoning not ending in punctuation + historyLine → well-formed: no doubled/orphan punctuation, single space separator', () => {
    const result = composeReasoningWithHistory('No trailing punctuation', 'History note.');
    expect(result).not.toMatch(/\.\./);
    expect(result).not.toMatch(/\s{2,}/);
    expect(result.trim().endsWith('History note.')).toBe(true);
  });

  it('result contains no newline characters even when modelReasoning has embedded newlines', () => {
    const result = composeReasoningWithHistory('One.\nTwo.\nThree.', 'History note.');
    expect(result).not.toMatch(/\n|\r/);
  });

  it('(adversarial) 2-sentence modelReasoning + historyLine → exactly 3 sentences, historyLine is the last sentence', () => {
    const result = composeReasoningWithHistory(
      'Sentence one. Sentence two.',
      'History note.'
    );
    expect(countSentences(result)).toBe(3);
    expect(result.trim().endsWith('History note.')).toBe(true);
    // The historyLine must not appear in the MIDDLE of the result
    const sentences = result.trim().split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    expect(sentences[sentences.length - 1].trim()).toBe('History note.');
  });

  it('result with historyLine contains no newline even when inputs have newlines', () => {
    const result = composeReasoningWithHistory(
      'Line one.\nLine two.',
      'History note.'
    );
    expect(result).not.toMatch(/\n|\r/);
  });
});

// ─── GAP 2: matchJobOnDemand on-demand caller integration ────────────────────
//
// These tests exercise the FULL caller path:
//   DB seed → history loading → normalisation in caller → applyCompanyHistoryNudge
//   → composeReasoningWithHistory → persisted MatchRecord score + reasoning
//
// Mock boundary: only OpenAI chat.completions.create is mocked (fixed base score + multi-sentence
// reasoning).  companyHistory functions, DB queries, and the wallet deduction are real.

describe('matchJobOnDemand — company history caller integration (GAP 2)', () => {
  let userId: mongoose.Types.ObjectId;
  let dbUser: any;

  // Seed a user once per describe; collections are cleared after each test by setup.ts.
  beforeEach(async () => {
    jest.clearAllMocks();
    userId = new mongoose.Types.ObjectId();
    dbUser = await User.create({
      _id: userId,
      email: `test-${userId.toString()}@example.com`,
      password: 'hashed_password',
      name: 'Test User',
      isVerified: true,
      walletBalance: 5.0,
      preferences: {
        minScore: 30,
        matchingEnabled: true,
        remoteOnly: false,
        minSalary: 0,
        location: [],
      },
      resume: {
        summary: 'Experienced TypeScript engineer',
        skills: ['TypeScript', 'Node.js'],
        experience: ['5 years at Foo Corp'],
        education: ['BSc Computer Science'],
      },
    });
  });

  // ── scenario A: normalisation-merging company variants + spec-derived nudge ──

  it('applies spec-derived nudge from normalised-company history and ≤3-sentence reasoning', async () => {
    // Spec calculation for 1 rejected + 1 no_response at "acme":
    //   rejected contribution:   1 × (−3) = −3
    //   no_response contribution: max(1 × (−1), −2) = −1   (floor at −2; 1 × −1 = −1, within floor)
    //   total raw nudge: −3 + (−1) = −4   → within [−5, +5], no clamp needed
    //   Gate: baseScore=70 ≥ minScore=30 AND 70+(−4)=66 ≥ 30 → same side → nudge applies
    //   adjustedScore = 66  (spec-derived, never observed from runtime)

    // Prior job 1 at "ACME Corp" (variant — normalises to "acme"), outcome=rejected
    const priorJob1 = await JobListing.create({
      title: 'Old Role',
      company: 'ACME Corp',
      location: ['Remote'],
      source: 'test',
      description: 'Some job',
      url: `https://example.com/prior1-${userId}`,
      scrapedDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    // Prior job 2 at "Acme Inc." (another variant — same normalised key), outcome=no_response
    const priorJob2 = await JobListing.create({
      title: 'Old Role 2',
      company: 'Acme Inc.',
      location: ['Remote'],
      source: 'test',
      description: 'Another job',
      url: `https://example.com/prior2-${userId}`,
      scrapedDate: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000),
    });
    // Unrelated company: "Other Corp" with heard_back (+1) — must NOT affect acme nudge
    const priorJobOther = await JobListing.create({
      title: 'Other Role',
      company: 'Other Corp',
      location: ['Remote'],
      source: 'test',
      description: 'Other job',
      url: `https://example.com/other-${userId}`,
      scrapedDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    });

    // Outcome MatchRecords for prior jobs (already applied)
    await MatchRecord.create({
      userId,
      jobId: priorJob1._id,
      matchScore: 60,
      verdict: 'Prior match',
      reasoning: 'Old reasoning',
      freshness: Freshness.STALE,
      clicked: true,
      skipped: false,
      applied: true,
      applicationOutcome: 'rejected',
    });
    await MatchRecord.create({
      userId,
      jobId: priorJob2._id,
      matchScore: 55,
      verdict: 'Prior match 2',
      reasoning: 'Old reasoning 2',
      freshness: Freshness.STALE,
      clicked: true,
      skipped: false,
      applied: true,
      applicationOutcome: 'no_response',
    });
    await MatchRecord.create({
      userId,
      jobId: priorJobOther._id,
      matchScore: 70,
      verdict: 'Prior match other',
      reasoning: 'Old reasoning other',
      freshness: Freshness.STALE,
      clicked: true,
      skipped: false,
      applied: true,
      applicationOutcome: 'heard_back',
    });

    // Target job: "Acme Inc." — normalises to "acme", should pick up the history
    const targetJob = await JobListing.create({
      title: 'Target Backend Engineer',
      company: 'Acme Inc.',
      location: ['Remote'],
      source: 'test',
      description: 'Exciting new role',
      url: `https://example.com/target-${userId}`,
      scrapedDate: new Date(),
      postedDate: new Date(),
    });

    // Mock OpenAI: fixed base score=70, 3-sentence reasoning (the cap will truncate 2 + history)
    mockCreate.mockResolvedValueOnce(
      chatResponse({
        matchScore: 70,
        verdict: 'Strong match',
        reasoning: 'First reason. Second reason. Third reason.',
      })
    );

    await invokeOnDemand(dbUser, (targetJob._id as mongoose.Types.ObjectId).toString());

    // Assert persisted MatchRecord
    const persisted = await MatchRecord.findOne({ userId, jobId: targetJob._id });
    expect(persisted).not.toBeNull();

    // Spec-derived adjustedScore = 66
    expect(persisted!.matchScore).toBe(66);

    // Reasoning: composed from first 2 sentences + historyLine → at most 3 sentences
    expect(countSentences(persisted!.reasoning)).toBeLessThanOrEqual(3);
    expect(persisted!.reasoning).not.toMatch(/\n|\r/);

    // HIT wiring: persisted reasoning must equal what the public helpers produce for this history.
    // Seeded: 1 rejected + 1 no_response at "acme".  minScore=30, baseScore=70.
    const seededHistoryHit = { rejected: 1, no_response: 1, heard_back: 0, interview: 0, offer: 0 };
    const { reasoningLine: hitReasoningLine } = applyCompanyHistoryNudge(70, 30, seededHistoryHit);
    const expectedHitReasoning = composeReasoningWithHistory('First reason. Second reason. Third reason.', hitReasoningLine);
    expect(persisted!.reasoning).toBe(expectedHitReasoning);
    // A wiring regression that skips composeReasoningWithHistory would leave the raw model
    // reasoning unchanged; this assertion catches that.
    expect(persisted!.reasoning).not.toBe('First reason. Second reason. Third reason.');

    // Unrelated company (Other Corp, +1 heard_back) must NOT have contributed to the nudge
    // If it had, adjustedScore would be 67 (−3 rejected + −1 no_response + 1 heard_back = −3)
    // which is NOT 66 — our assertion above catches any such bleed-through.

    // FIX 3: payload assertion — HIT case
    // matchJobOnDemand issues exactly 1 OpenAI call (no stability sampling in the backend path).
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const sentUserInfoHit = extractUserInfoFromCreateCall(mockCreate.mock.calls[0][0]);
    // Spec-oracle: seeded 1 rejected + 1 no_response at normalised "acme" company.
    // The companyHistory field must be present in the prompt with those exact counts.
    expect(sentUserInfoHit).toHaveProperty('companyHistory');
    expect(sentUserInfoHit.companyHistory.rejected).toBe(1);
    expect(sentUserInfoHit.companyHistory.no_response).toBe(1);
  });

  // ── scenario B: company with NO prior outcomes → score unchanged, no history note ──

  it('company with no prior outcome history → score unchanged, reasoning has no history note', async () => {
    const freshJob = await JobListing.create({
      title: 'Brand New Job',
      company: 'Completely New Corp',
      location: ['Remote'],
      source: 'test',
      description: 'Fresh role',
      url: `https://example.com/fresh-${userId}`,
      scrapedDate: new Date(),
      postedDate: new Date(),
    });

    const rawReasoning = 'First sentence. Second sentence. Third sentence.';
    mockCreate.mockResolvedValueOnce(
      chatResponse({ matchScore: 72, verdict: 'Good match', reasoning: rawReasoning })
    );

    await invokeOnDemand(dbUser, (freshJob._id as mongoose.Types.ObjectId).toString());

    const persisted = await MatchRecord.findOne({ userId, jobId: freshJob._id });
    expect(persisted).not.toBeNull();

    // No history → score must be unchanged
    expect(persisted!.matchScore).toBe(72);
    // Reasoning must be at most 3 sentences (composeReasoningWithHistory with null historyLine
    // returns the base reasoning trimmed — any truncation is the service's business, not ours)
    expect(countSentences(persisted!.reasoning)).toBeLessThanOrEqual(3);
    // MISS wiring: no history note appended — reasoning equals raw model reasoning, trimmed.
    expect(persisted!.reasoning).toBe(rawReasoning.trim());

    // FIX 3: payload assertion — MISS case
    // companyHistory must be ABSENT from the prompt when there are no prior outcomes.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const sentUserInfoMiss = extractUserInfoFromCreateCall(mockCreate.mock.calls[0][0]);
    expect(sentUserInfoMiss).not.toHaveProperty('companyHistory');
  });

  // ── scenario C: falsy-zero minScore path ──

  it('user with minScore=0: spec nudge is applied (falsy-zero ||30 bug would suppress it)', async () => {
    // Spec calculation: baseScore=25, minScore=0, offer × 2 → nudge=+5 (clamped), adjustedScore=30
    // Gate: (25 < 0)=false, (30 < 0)=false → same side → nudge MUST be applied.
    // Bug trap: `minScore || 30` substitutes 30; gate then fires (25<30=true, 30<30=false → opposite)
    // and the score stays at 25 — NOT 30.  Only `minScore ?? 30` passes this test.

    // User with minScore=0
    await User.findByIdAndUpdate(userId, { 'preferences.minScore': 0 });
    const freshDbUser = await User.findById(userId);

    // Seed history: 2 offers at "Boost Corp" → nudge = 2×(+4) = +8, clamped to +5
    const priorOfferJob1 = await JobListing.create({
      title: 'Offer Job 1',
      company: 'Boost Corp',
      location: ['Remote'],
      source: 'test',
      description: 'Some job',
      url: `https://example.com/offer1-${userId}`,
      scrapedDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const priorOfferJob2 = await JobListing.create({
      title: 'Offer Job 2',
      company: 'Boost Corp',
      location: ['Remote'],
      source: 'test',
      description: 'Another job',
      url: `https://example.com/offer2-${userId}`,
      scrapedDate: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000),
    });
    await MatchRecord.create({
      userId,
      jobId: priorOfferJob1._id,
      matchScore: 80,
      verdict: 'Prior',
      reasoning: 'Old',
      freshness: Freshness.STALE,
      clicked: true,
      skipped: false,
      applied: true,
      applicationOutcome: 'offer',
    });
    await MatchRecord.create({
      userId,
      jobId: priorOfferJob2._id,
      matchScore: 85,
      verdict: 'Prior 2',
      reasoning: 'Old 2',
      freshness: Freshness.STALE,
      clicked: true,
      skipped: false,
      applied: true,
      applicationOutcome: 'offer',
    });

    const targetJob = await JobListing.create({
      title: 'New Boost Corp Role',
      company: 'Boost Corp',
      location: ['Remote'],
      source: 'test',
      description: 'Great role',
      url: `https://example.com/boosttarget-${userId}`,
      scrapedDate: new Date(),
      postedDate: new Date(),
    });

    // OpenAI returns baseScore=25 — within the nudge range
    mockCreate.mockResolvedValueOnce(
      chatResponse({ matchScore: 25, verdict: 'Good', reasoning: 'One. Two. Three.' })
    );

    await invokeOnDemand(freshDbUser, (targetJob._id as mongoose.Types.ObjectId).toString());

    const persisted = await MatchRecord.findOne({ userId, jobId: targetJob._id });
    expect(persisted).not.toBeNull();

    // Spec-derived: nudge = min(+8, +5) = +5.  adjustedScore = 25 + 5 = 30.
    // Gate with minScore=0: (25 < 0)=false, (30 < 0)=false → same side → gate does NOT fire.
    // Expected: 30.  If the `||30` bug is present, the gate fires and returns 25.
    expect(persisted!.matchScore).toBe(30);
  });

  // ── scenario D: history for deleted JobListing is skipped ──

  it('prior outcome at a deleted JobListing (no company name) does not contribute to the history', async () => {
    // Seed: one prior outcome MatchRecord whose jobId no longer exists in JobListing
    // (simulates a deleted job listing — the company join returns nothing for that jobId)
    const deletedJobId = new mongoose.Types.ObjectId(); // never inserted into JobListing
    await MatchRecord.create({
      userId,
      jobId: deletedJobId,
      matchScore: 60,
      verdict: 'Ghost',
      reasoning: 'Old',
      freshness: Freshness.STALE,
      clicked: false,
      skipped: false,
      applied: true,
      applicationOutcome: 'interview', // +3 if it leaked through
    });

    // Target job at a company that would match IF the deleted outcome leaked (unlikely, since
    // the company name is unknown, but we test the isolation explicitly)
    const targetJob = await JobListing.create({
      title: 'Isolated Role',
      company: 'Isolated Corp',
      location: ['Remote'],
      source: 'test',
      description: 'Some role',
      url: `https://example.com/isolated-${userId}`,
      scrapedDate: new Date(),
      postedDate: new Date(),
    });

    mockCreate.mockResolvedValueOnce(
      chatResponse({ matchScore: 50, verdict: 'Match', reasoning: 'One. Two. Three.' })
    );

    await invokeOnDemand(dbUser, (targetJob._id as mongoose.Types.ObjectId).toString());

    const persisted = await MatchRecord.findOne({ userId, jobId: targetJob._id });
    expect(persisted).not.toBeNull();
    // No valid company → no nudge → score unchanged at 50
    expect(persisted!.matchScore).toBe(50);
  });
});
