/**
 * ADVERSARIAL TEST — onlyjobs-kjc
 * Hardening pass on POST /api/matches/trigger-for-me eligibility gate.
 * Priority cases: atomic cooldown concurrency + temporal eligibility race.
 *
 * CONTRACT = oracle (from task specification). Every expected value traces to the contract.
 * FORBIDDEN files NOT opened:
 *   src/controllers/matchController.ts
 *   src/__tests__/triggerMatch.test.ts
 *   src/__tests__/triggerGate.adversarial.test.ts
 *
 * DISCLOSURE: see bottom of file.
 */

// Mocks must be hoisted before any imports.
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({}),
}));

jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import matchRoutes from '../routes/matchRoutes';

// ── Env vars ──────────────────────────────────────────────────────────────────
const FAKE_BG_URL = 'http://fake-background-service-race';
const FAKE_SECRET = 'race-test-trigger-secret';

const _origBgUrl: string | undefined = process.env.BACKGROUND_SERVICE_URL;
const _origSecret: string | undefined = process.env.INTERNAL_TRIGGER_SECRET;

// ── Fetch mock ────────────────────────────────────────────────────────────────
let mockFetch: jest.MockedFunction<typeof fetch>;

// ── Test app ──────────────────────────────────────────────────────────────────
let currentUserId: mongoose.Types.ObjectId;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.user = { _id: currentUserId };
  next();
});
testApp.use('/api/matches', matchRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

// ── Global setup ──────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.BACKGROUND_SERVICE_URL = FAKE_BG_URL;
  process.env.INTERNAL_TRIGGER_SECRET = FAKE_SECRET;
  global.fetch = jest.fn();
  mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;
});

afterAll(() => {
  if (_origBgUrl === undefined) delete process.env.BACKGROUND_SERVICE_URL;
  else process.env.BACKGROUND_SERVICE_URL = _origBgUrl;
  if (_origSecret === undefined) delete process.env.INTERNAL_TRIGGER_SECRET;
  else process.env.INTERNAL_TRIGGER_SECRET = _origSecret;
});

beforeEach(() => {
  currentUserId = new mongoose.Types.ObjectId();
  mockFetch.mockReset();
  // Default: dispatch succeeds
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  } as Response);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createEligibleUser(
  userId: mongoose.Types.ObjectId,
  overrides: Record<string, any> = {}
) {
  const { preferences: prefOverrides, ...rest } = overrides;
  return User.create({
    _id: userId,
    name: 'Race Test User',
    email: `trigger-race-adv-${userId.toString()}@example.com`,
    password: 'hashed',
    resume: {
      skills: ['TypeScript', 'Node.js'],
      experience: [],
      education: [],
      summary: 'Senior backend engineer',
    },
    preferences: {
      jobTypes: [],
      location: [],
      remoteOnly: false,
      minSalary: 0,
      industries: [],
      minScore: 30,
      matchingEnabled: true,
      ...prefOverrides,
    },
    isVerified: true,
    walletBalance: 1.00,
    ...rest,
  });
}

// Returns a proxy that behaves as a Mongoose Query thenable but allows chaining
// any method (select, lean, populate, etc.) by returning itself.
function makeMockQuery(resolvedValue: any): any {
  const p = Promise.resolve(resolvedValue);
  const proxy: any = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') return p.then.bind(p);
        if (prop === 'catch') return p.catch.bind(p);
        if (prop === 'finally') return p.finally.bind(p);
        if (prop === 'exec') return () => p;
        // Any chaining method (select, lean, populate…) returns the same proxy
        return () => proxy;
      },
    }
  );
  return proxy;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONCURRENCY — highest-value adversarial case
// ═══════════════════════════════════════════════════════════════════════════════

describe('CONCURRENCY: two simultaneous POSTs — exactly one 202, one 429', () => {

  it('C-1: Promise.all of two trigger calls yields exactly [202, 429] in any order', async () => {
    await createEligibleUser(currentUserId);

    const [res1, res2] = await Promise.all([
      request(testApp).post('/api/matches/trigger-for-me'),
      request(testApp).post('/api/matches/trigger-for-me'),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // CRITICAL FINDING if [202, 202]: naive read-then-write let both dispatch
    // CRITICAL FINDING if [429, 429]: atomic claim rejected both (logic error)
    expect(statuses).toEqual([202, 429]);
  });

  it('C-2: fetch called exactly once — only the winning request dispatches', async () => {
    await createEligibleUser(currentUserId);

    await Promise.all([
      request(testApp).post('/api/matches/trigger-for-me'),
      request(testApp).post('/api/matches/trigger-for-me'),
    ]);

    // CRITICAL FINDING if 2: both requests dispatched to background service
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('C-3: after concurrent requests, lastManualMatchAt is set exactly once in DB', async () => {
    await createEligibleUser(currentUserId);
    const before = await User.findById(currentUserId);
    expect(before!.lastManualMatchAt).toBeUndefined();

    await Promise.all([
      request(testApp).post('/api/matches/trigger-for-me'),
      request(testApp).post('/api/matches/trigger-for-me'),
    ]);

    const after = await User.findById(currentUserId);
    // FINDING if undefined: winning request didn't persist lastManualMatchAt
    expect(after!.lastManualMatchAt).toBeInstanceOf(Date);
  });

  it('C-4: the 429 response includes retryAfterMinutes as a number [contract: 429 shape]', async () => {
    await createEligibleUser(currentUserId);

    const [res1, res2] = await Promise.all([
      request(testApp).post('/api/matches/trigger-for-me'),
      request(testApp).post('/api/matches/trigger-for-me'),
    ]);

    const cooldown429 = [res1, res2].find((r) => r.status === 429);
    expect(cooldown429).toBeDefined();
    // FINDING if not a number: retryAfterMinutes missing or wrong type
    expect(typeof cooldown429!.body.retryAfterMinutes).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPORAL ELIGIBILITY RACE — eligible at snapshot, ineligible in DB at claim time
// ═══════════════════════════════════════════════════════════════════════════════

describe('TEMPORAL RACE: wallet drains between snapshot and atomic claim', () => {

  it('TR-W1: snapshot eligible (balance=1.0), DB has walletBalance=0 → 400 insufficient_balance, fetch NOT called', async () => {
    // Real DB doc is INELIGIBLE
    await createEligibleUser(currentUserId, { walletBalance: 0 });

    // Spy: first findById (snapshot) returns a stale eligible view
    const spy = jest.spyOn(User, 'findById').mockImplementationOnce(
      () => makeMockQuery({
        _id: currentUserId,
        isVerified: true,
        resume: { skills: ['TypeScript'], summary: 'Senior', experience: [], education: [] },
        preferences: { matchingEnabled: true, jobTypes: [], location: [], remoteOnly: false, minSalary: 0, industries: [], minScore: 30 },
        walletBalance: 1.00,
        lastManualMatchAt: undefined,
      })
    );

    const res = await request(testApp).post('/api/matches/trigger-for-me');
    spy.mockRestore();

    // CRITICAL FINDING if 202: atomic claim didn't re-check wallet → dispatched to ineligible user
    // CRITICAL FINDING if 429: cooldown burned without dispatch
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('insufficient_balance');
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it('TR-W2: wallet race → lastManualMatchAt NOT advanced (cooldown not burned)', async () => {
    await createEligibleUser(currentUserId, { walletBalance: 0 });

    const spy = jest.spyOn(User, 'findById').mockImplementationOnce(
      () => makeMockQuery({
        _id: currentUserId,
        isVerified: true,
        resume: { skills: ['TypeScript'], summary: 'Senior', experience: [], education: [] },
        preferences: { matchingEnabled: true },
        walletBalance: 1.00,
      })
    );

    await request(testApp).post('/api/matches/trigger-for-me');
    spy.mockRestore();

    const afterUser = await User.findById(currentUserId);
    // CRITICAL FINDING if defined: cooldown burned despite failed atomic claim
    expect(afterUser!.lastManualMatchAt).toBeUndefined();
  });
});

describe('TEMPORAL RACE: matchingEnabled flips to false between snapshot and claim', () => {

  it('TR-M1: snapshot shows enabled=true, DB has matchingEnabled=false → 400 matching_disabled, fetch NOT called', async () => {
    await createEligibleUser(currentUserId, { preferences: { matchingEnabled: false } });

    const spy = jest.spyOn(User, 'findById').mockImplementationOnce(
      () => makeMockQuery({
        _id: currentUserId,
        isVerified: true,
        resume: { skills: ['TypeScript'], summary: 'Senior', experience: [], education: [] },
        preferences: { matchingEnabled: true },
        walletBalance: 1.00,
      })
    );

    const res = await request(testApp).post('/api/matches/trigger-for-me');
    spy.mockRestore();

    // CRITICAL FINDING if 202: atomic claim didn't re-check matchingEnabled
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('matching_disabled');
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it('TR-M2: matchingEnabled race → lastManualMatchAt NOT advanced', async () => {
    await createEligibleUser(currentUserId, { preferences: { matchingEnabled: false } });

    const spy = jest.spyOn(User, 'findById').mockImplementationOnce(
      () => makeMockQuery({
        _id: currentUserId,
        isVerified: true,
        resume: { skills: ['TypeScript'], summary: 'Senior', experience: [], education: [] },
        preferences: { matchingEnabled: true },
        walletBalance: 1.00,
      })
    );

    await request(testApp).post('/api/matches/trigger-for-me');
    spy.mockRestore();

    const afterUser = await User.findById(currentUserId);
    expect(afterUser!.lastManualMatchAt).toBeUndefined();
  });
});

describe('TEMPORAL RACE: isVerified flips to false between snapshot and claim', () => {

  it('TR-V1: snapshot shows verified=true, DB has isVerified=false → 403 unverified, fetch NOT called', async () => {
    await createEligibleUser(currentUserId, { isVerified: false });

    const spy = jest.spyOn(User, 'findById').mockImplementationOnce(
      () => makeMockQuery({
        _id: currentUserId,
        isVerified: true,
        resume: { skills: ['TypeScript'], summary: 'Senior', experience: [], education: [] },
        preferences: { matchingEnabled: true },
        walletBalance: 1.00,
      })
    );

    const res = await request(testApp).post('/api/matches/trigger-for-me');
    spy.mockRestore();

    // CRITICAL FINDING if 202: atomic claim didn't re-check isVerified
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('unverified');
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it('TR-V2: isVerified race → lastManualMatchAt NOT advanced', async () => {
    await createEligibleUser(currentUserId, { isVerified: false });

    const spy = jest.spyOn(User, 'findById').mockImplementationOnce(
      () => makeMockQuery({
        _id: currentUserId,
        isVerified: true,
        resume: { skills: ['TypeScript'], summary: 'Senior', experience: [], education: [] },
        preferences: { matchingEnabled: true },
        walletBalance: 1.00,
      })
    );

    await request(testApp).post('/api/matches/trigger-for-me');
    spy.mockRestore();

    const afterUser = await User.findById(currentUserId);
    expect(afterUser!.lastManualMatchAt).toBeUndefined();
  });
});

describe('TEMPORAL RACE: resume cleared between snapshot and atomic claim', () => {

  it('TR-R1: snapshot has meaningful resume, DB resume is blank → 400 no_resume, fetch NOT called, lastManualMatchAt NOT set', async () => {
    // Real DB doc: scalar-eligible (verified + funded + matchingEnabled) but resume fails hasMeaningfulResume.
    // Summary is whitespace-only; skills/experience/education are empty — every arm of the predicate returns false.
    await createEligibleUser(currentUserId, {
      resume: { skills: [], experience: [], education: [], summary: '   ' },
    });

    // Stale snapshot: meaningful resume passes hasMeaningfulResume (non-blank summary + real skills),
    // all scalar gates also pass — handler proceeds past snapshot gates and into the atomic claim.
    const spy = jest.spyOn(User, 'findById').mockImplementationOnce(
      () => makeMockQuery({
        _id: currentUserId,
        isVerified: true,
        resume: {
          skills: ['TypeScript', 'Node.js'],
          experience: ['5 years backend engineering'],
          education: [],
          summary: 'Senior Engineer',
        },
        preferences: { matchingEnabled: true, jobTypes: [], location: [], remoteOnly: false, minSalary: 0, industries: [], minScore: 30 },
        walletBalance: 1.00,
        lastManualMatchAt: undefined,
      })
    );

    const res = await request(testApp).post('/api/matches/trigger-for-me');
    spy.mockRestore();

    // CONTRACT: resume revalidated post-claim against the atomically-claimed document;
    // non-meaningful resume in DB → no dispatch, no cooldown burn.
    // CRITICAL FINDING if 202: post-claim resume revalidation not implemented — dispatched despite blank resume
    // CRITICAL FINDING if 429: atomic claim succeeded but rollback failed — cooldown left set to now
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
    expect(mockFetch).toHaveBeenCalledTimes(0);

    const afterUser = await User.findById(currentUserId);
    // CRITICAL FINDING if defined: cooldown was burned (lastManualMatchAt advanced) despite no dispatch
    expect(afterUser!.lastManualMatchAt).toBeUndefined();
  });

  it('TR-R2: prior lastManualMatchAt=7h ago; resume race → lastManualMatchAt RESTORED to original value (not cleared, not advanced to now)', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);

    // Real DB doc: scalar-eligible + prior cooldown 7h ago (outside 6h window → does not block the claim)
    // but resume fails hasMeaningfulResume. Atomic claim can still match and advance lastManualMatchAt.
    await createEligibleUser(currentUserId, {
      resume: { skills: [], experience: [], education: [], summary: '   ' },
      lastManualMatchAt: sevenHoursAgo,
    });

    // Stale snapshot: meaningful resume + prior cooldown 7h ago (past-window → snapshot cooldown gate passes)
    const spy = jest.spyOn(User, 'findById').mockImplementationOnce(
      () => makeMockQuery({
        _id: currentUserId,
        isVerified: true,
        resume: {
          skills: ['TypeScript', 'Node.js'],
          experience: ['5 years backend engineering'],
          education: [],
          summary: 'Senior Engineer',
        },
        preferences: { matchingEnabled: true, jobTypes: [], location: [], remoteOnly: false, minSalary: 0, industries: [], minScore: 30 },
        walletBalance: 1.00,
        lastManualMatchAt: sevenHoursAgo,
      })
    );

    const res = await request(testApp).post('/api/matches/trigger-for-me');
    spy.mockRestore();

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
    expect(mockFetch).toHaveBeenCalledTimes(0);

    const afterUser = await User.findById(currentUserId);
    // CONTRACT: rollback must RESTORE the previous lastManualMatchAt, not clear it or leave it at now.
    // CRITICAL FINDING if undefined: rollback erased the legitimate prior cooldown timestamp
    // CRITICAL FINDING if diffMs large (close to 7h): lastManualMatchAt advanced to now and not rolled back
    expect(afterUser!.lastManualMatchAt).toBeDefined();
    const diffMs = Math.abs(afterUser!.lastManualMatchAt!.getTime() - sevenHoursAgo.getTime());
    expect(diffMs).toBeLessThan(2000); // within 2s of original value — proves restore, not clear-or-advance
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SNAPSHOT GATE REGRESSION
// ═══════════════════════════════════════════════════════════════════════════════

describe('SNAPSHOT GATES: unverified', () => {

  it('SG-1: isVerified=false → 403 unverified, fetch NOT called, lastManualMatchAt NOT set', async () => {
    await createEligibleUser(currentUserId, { isVerified: false });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('unverified');
    expect(mockFetch).toHaveBeenCalledTimes(0);
    const user = await User.findById(currentUserId);
    expect(user!.lastManualMatchAt).toBeUndefined();
  });
});

describe('SNAPSHOT GATES: no meaningful resume', () => {

  it('SG-2a: all resume fields blank → 400 no_resume', async () => {
    await createEligibleUser(currentUserId, {
      resume: { skills: [], experience: [], education: [], summary: '' },
    });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
  });

  it('SG-2b: resume summary is only whitespace → 400 no_resume', async () => {
    await createEligibleUser(currentUserId, {
      resume: { skills: [], experience: [], education: [], summary: '   ' },
    });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
  });

  it('SG-2c: resume=null (raw insert) → 400 no_resume', async () => {
    await User.collection.insertOne({
      _id: currentUserId,
      name: 'Null Resume',
      email: `null-resume-${currentUserId.toString()}@example.com`,
      password: 'hashed',
      resume: null,
      preferences: { jobTypes: [], location: [], remoteOnly: false, minSalary: 0, industries: [], minScore: 30, matchingEnabled: true },
      isVerified: true,
      walletBalance: 1.00,
      skippedJobs: [],
      qna: [],
      balanceReminderCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
  });

  it('SG-2d: no_resume → fetch NOT called, lastManualMatchAt NOT set', async () => {
    await createEligibleUser(currentUserId, {
      resume: { skills: [], experience: [], education: [], summary: '' },
    });
    await request(testApp).post('/api/matches/trigger-for-me');
    expect(mockFetch).toHaveBeenCalledTimes(0);
    const user = await User.findById(currentUserId);
    expect(user!.lastManualMatchAt).toBeUndefined();
  });
});

describe('SNAPSHOT GATES: matching disabled', () => {

  it('SG-3: matchingEnabled=false → 400 matching_disabled, fetch NOT called, lastManualMatchAt NOT set', async () => {
    await createEligibleUser(currentUserId, { preferences: { matchingEnabled: false } });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('matching_disabled');
    expect(mockFetch).toHaveBeenCalledTimes(0);
    const user = await User.findById(currentUserId);
    expect(user!.lastManualMatchAt).toBeUndefined();
  });
});

describe('SNAPSHOT GATES: insufficient balance', () => {

  it('SG-4a: walletBalance=0 → 400 insufficient_balance', async () => {
    await createEligibleUser(currentUserId, { walletBalance: 0 });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('insufficient_balance');
  });

  it('SG-4b: 400 body includes walletBalance field and required=0.3 [contract: body shape]', async () => {
    await createEligibleUser(currentUserId, { walletBalance: 0.10 });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(400);
    // FINDING if undefined: response body missing walletBalance or required fields
    expect(res.body.walletBalance).toBeDefined();
    expect(res.body.required).toBe(0.3);
  });

  it('SG-4c: insufficient_balance → fetch NOT called, lastManualMatchAt NOT set', async () => {
    await createEligibleUser(currentUserId, { walletBalance: 0 });
    await request(testApp).post('/api/matches/trigger-for-me');
    expect(mockFetch).toHaveBeenCalledTimes(0);
    const user = await User.findById(currentUserId);
    expect(user!.lastManualMatchAt).toBeUndefined();
  });
});

describe('SNAPSHOT GATES: multi-gate — first gate wins', () => {

  it('SG-5a: unverified + no_resume + wallet=0 → 403 unverified (unverified is first gate)', async () => {
    await createEligibleUser(currentUserId, {
      isVerified: false,
      resume: { skills: [], experience: [], education: [], summary: '' },
      walletBalance: 0,
    });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 400: a later gate took priority over unverified
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('unverified');
  });

  it('SG-5b: verified + no_resume + matchingEnabled=false → 400 no_resume (no_resume before matching_disabled)', async () => {
    await createEligibleUser(currentUserId, {
      resume: { skills: [], experience: [], education: [], summary: '' },
      preferences: { matchingEnabled: false },
    });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if reason=matching_disabled: gate order wrong
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════════

describe('WALLET BOUNDARY', () => {

  it('WB-1: walletBalance=0.30 → 202 (0.30 is NOT < 0.30 — exact boundary is eligible)', async () => {
    await createEligibleUser(currentUserId, { walletBalance: 0.30 });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // CRITICAL FINDING if 400: boundary incorrectly treated as insufficient (off-by-epsilon)
    expect(res.status).toBe(202);
  });

  it('WB-2: walletBalance=0.29 → 400 insufficient_balance (0.29 < 0.30)', async () => {
    await createEligibleUser(currentUserId, { walletBalance: 0.29 });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 202: 0.29 passes the 0.30 threshold
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('insufficient_balance');
  });

  it('WB-3: walletBalance field absent from DB doc → 400 insufficient_balance (treated as 0)', async () => {
    await User.collection.insertOne({
      _id: currentUserId,
      name: 'No Balance',
      email: `no-balance-${currentUserId.toString()}@example.com`,
      password: 'hashed',
      resume: { skills: ['TypeScript'], experience: [], education: [], summary: 'Senior' },
      preferences: { jobTypes: [], location: [], remoteOnly: false, minSalary: 0, industries: [], minScore: 30, matchingEnabled: true },
      isVerified: true,
      // walletBalance deliberately absent
      skippedJobs: [],
      qna: [],
      balanceReminderCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 202: undefined walletBalance not treated as 0
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('insufficient_balance');
  });

  it('WB-4: at boundary (0.30) dispatch fires with correct URL and userId in body', async () => {
    await createEligibleUser(currentUserId, { walletBalance: 0.30 });
    await request(testApp).post('/api/matches/trigger-for-me');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FAKE_BG_URL}/internal/match-for-user`);
    const body = JSON.parse(options.body as string);
    expect(body.userId).toBe(currentUserId.toString());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// matchingEnabled EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('matchingEnabled edge cases', () => {

  it('ME-1: matchingEnabled absent from DB doc → eligible (undefined !== false)', async () => {
    await User.collection.insertOne({
      _id: currentUserId,
      name: 'Undefined Matching',
      email: `matching-undef-${currentUserId.toString()}@example.com`,
      password: 'hashed',
      resume: { skills: ['TypeScript'], experience: [], education: [], summary: 'Senior' },
      preferences: { jobTypes: [], location: [], remoteOnly: false, minSalary: 0, industries: [], minScore: 30 },
      // matchingEnabled absent from preferences
      isVerified: true,
      walletBalance: 1.00,
      skippedJobs: [],
      qna: [],
      balanceReminderCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // CRITICAL FINDING if 400 matching_disabled: undefined treated as false
    expect(res.status).toBe(202);
  });

  it('ME-2: matchingEnabled=true (explicit) → eligible', async () => {
    await createEligibleUser(currentUserId); // default has matchingEnabled=true
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(202);
  });

  it('ME-3: matchingEnabled=false → 400 matching_disabled', async () => {
    await createEligibleUser(currentUserId, { preferences: { matchingEnabled: false } });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('matching_disabled');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COOLDOWN — serial requests
// ═══════════════════════════════════════════════════════════════════════════════

describe('COOLDOWN: serial requests', () => {

  it('CD-1: lastManualMatchAt=now → 429, fetch NOT called', async () => {
    await createEligibleUser(currentUserId, { lastManualMatchAt: new Date() });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 202: cooldown not enforced
    expect(res.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it('CD-2: 429 response includes retryAfterMinutes as a number ≤ 360', async () => {
    await createEligibleUser(currentUserId, { lastManualMatchAt: new Date() });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(429);
    // FINDING if not a number: retryAfterMinutes wrong type or absent
    expect(typeof res.body.retryAfterMinutes).toBe('number');
    // Immediately after setting, should be close to 360 minutes remaining
    expect(res.body.retryAfterMinutes).toBeGreaterThan(350);
    expect(res.body.retryAfterMinutes).toBeLessThanOrEqual(360);
  });

  it('CD-3: lastManualMatchAt=7h ago → eligible → 202 (past 6h window)', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await createEligibleUser(currentUserId, { lastManualMatchAt: sevenHoursAgo });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 429: 7h-old cooldown incorrectly still enforced
    expect(res.status).toBe(202);
  });

  it('CD-4: lastManualMatchAt=5h59m ago → 429 (within 6h window)', async () => {
    const almostSixHoursAgo = new Date(Date.now() - (6 * 60 - 1) * 60 * 1000);
    await createEligibleUser(currentUserId, { lastManualMatchAt: almostSixHoursAgo });
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 202: boundary is wrong (< 6h passes)
    expect(res.status).toBe(429);
  });

  it('CD-5: no lastManualMatchAt → eligible → 202 (no cooldown when fresh)', async () => {
    await createEligibleUser(currentUserId); // no lastManualMatchAt
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(202);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISPATCH FAILURE ROLLBACK
// ═══════════════════════════════════════════════════════════════════════════════

describe('DISPATCH FAILURE ROLLBACK', () => {

  it('DF-1: no prior cooldown, fetch returns ok=false → 502, lastManualMatchAt NOT set', async () => {
    await createEligibleUser(currentUserId); // no lastManualMatchAt
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => 'backend error' } as unknown as Response);

    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 202: failed dispatch treated as success
    expect(res.status).toBe(502);
    // Proves the non-ok branch ran (not the catch/unreachable branch)
    expect(res.body.message).toBe('Failed to start matching');

    const afterUser = await User.findById(currentUserId);
    // CRITICAL FINDING if defined: cooldown burned despite a failed dispatch
    expect(afterUser!.lastManualMatchAt).toBeUndefined();
  });

  it('DF-2: prior cooldown 7h ago, fetch ok=false → 502, lastManualMatchAt RESTORED to original value', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await createEligibleUser(currentUserId, { lastManualMatchAt: sevenHoursAgo });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}), text: async () => 'service unavailable' } as unknown as Response);

    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(502);
    // Proves the non-ok branch ran (not the catch/unreachable branch)
    expect(res.body.message).toBe('Failed to start matching');

    const afterUser = await User.findById(currentUserId);
    expect(afterUser!.lastManualMatchAt).toBeDefined();
    // CRITICAL FINDING if diffMs is large: lastManualMatchAt was advanced to "now" (not rolled back)
    const diffMs = Math.abs(afterUser!.lastManualMatchAt!.getTime() - sevenHoursAgo.getTime());
    expect(diffMs).toBeLessThan(2000); // within 2s of original value
  });

  it('DF-3: fetch THROWS → 502, lastManualMatchAt NOT set', async () => {
    await createEligibleUser(currentUserId);
    mockFetch.mockRejectedValueOnce(new Error('Network connection refused'));

    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 500: unhandled throw not converted to 502
    expect(res.status).toBe(502);
    // Proves the catch/unreachable path ran (distinct from the non-ok branch)
    expect(res.body.message).toBe('Matching service unreachable');

    const afterUser = await User.findById(currentUserId);
    // CRITICAL FINDING if defined: thrown dispatch burned the cooldown
    expect(afterUser!.lastManualMatchAt).toBeUndefined();
  });

  it('DF-4: after rollback, subsequent trigger attempt succeeds → 202 (retry is unblocked)', async () => {
    await createEligibleUser(currentUserId);

    // First attempt: dispatch fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => 'backend error' } as unknown as Response);
    const res1 = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res1.status).toBe(502);
    // Proves the non-ok branch ran on the first attempt
    expect(res1.body.message).toBe('Failed to start matching');

    // Second attempt: dispatch succeeds — rollback must have cleared the cooldown
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
    const res2 = await request(testApp).post('/api/matches/trigger-for-me');
    // CRITICAL FINDING if 429: rollback failed — cooldown lingered after a failed dispatch
    expect(res2.status).toBe(202);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HAPPY PATH
// ═══════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH', () => {

  it('HP-1: eligible user, dispatch ok → 202', async () => {
    await createEligibleUser(currentUserId);
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res.status).toBe(202);
  });

  it('HP-2: fetch called once with correct URL [contract: ${BACKGROUND_SERVICE_URL}/internal/match-for-user]', async () => {
    await createEligibleUser(currentUserId);
    await request(testApp).post('/api/matches/trigger-for-me');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FAKE_BG_URL}/internal/match-for-user`);
  });

  it('HP-3: fetch body contains userId as a string [contract: body { userId }]', async () => {
    await createEligibleUser(currentUserId);
    await request(testApp).post('/api/matches/trigger-for-me');
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    // FINDING if different: userId not propagated correctly to background service
    expect(body.userId).toBe(currentUserId.toString());
  });

  it('HP-4: fetch includes X-Internal-Secret header [contract: header X-Internal-Secret]', async () => {
    await createEligibleUser(currentUserId);
    await request(testApp).post('/api/matches/trigger-for-me');
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    // FINDING if undefined: X-Internal-Secret header missing
    expect(headers['X-Internal-Secret']).toBe(FAKE_SECRET);
  });

  it('HP-5: lastManualMatchAt set in DB to approximately now', async () => {
    const beforeTime = Date.now();
    await createEligibleUser(currentUserId);
    await request(testApp).post('/api/matches/trigger-for-me');
    const afterUser = await User.findById(currentUserId);
    // FINDING if undefined: lastManualMatchAt not written on success
    expect(afterUser!.lastManualMatchAt).toBeDefined();
    expect(afterUser!.lastManualMatchAt!.getTime()).toBeGreaterThanOrEqual(beforeTime);
  });

  it('HP-6: second call within 6h → 429 (successful first call sets cooldown)', async () => {
    await createEligibleUser(currentUserId);
    const res1 = await request(testApp).post('/api/matches/trigger-for-me');
    expect(res1.status).toBe(202);

    // Immediately retry — should be cooled down
    const res2 = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 202: cooldown not enforced after successful dispatch
    expect(res2.status).toBe(429);
    // Only one fetch total
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 503: INTERNAL_TRIGGER_SECRET not configured
// ═══════════════════════════════════════════════════════════════════════════════

describe('503: INTERNAL_TRIGGER_SECRET missing', () => {

  afterEach(() => {
    // Always restore — next test needs the secret
    process.env.INTERNAL_TRIGGER_SECRET = FAKE_SECRET;
  });

  it('SC-1: eligible user but INTERNAL_TRIGGER_SECRET unset → 503', async () => {
    await createEligibleUser(currentUserId);
    delete process.env.INTERNAL_TRIGGER_SECRET;
    const res = await request(testApp).post('/api/matches/trigger-for-me');
    // FINDING if 202: missing secret allowed dispatch to proceed
    expect(res.status).toBe(503);
  });

  it('SC-2: missing secret → fetch NOT called', async () => {
    await createEligibleUser(currentUserId);
    delete process.env.INTERNAL_TRIGGER_SECRET;
    await request(testApp).post('/api/matches/trigger-for-me');
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it('SC-3: missing secret → lastManualMatchAt NOT advanced (cooldown not burned)', async () => {
    await createEligibleUser(currentUserId);
    delete process.env.INTERNAL_TRIGGER_SECRET;
    await request(testApp).post('/api/matches/trigger-for-me');
    const user = await User.findById(currentUserId);
    expect(user!.lastManualMatchAt).toBeUndefined();
  });
});

/*
 * ══════════════════════════════════════════════════════════════════════════════
 * DISCLOSURE
 *
 * Files opened while writing this test (from the allowed list):
 *   backend/src/models/User.ts                   — IUser interface, schema fields (walletBalance,
 *                                                   isVerified, lastManualMatchAt, preferences,
 *                                                   resume, matchingEnabled default=true)
 *   backend/src/routes/matchRoutes.ts            — confirmed POST /trigger-for-me, protect middleware
 *   backend/src/utils/resumePredicate.ts         — hasMeaningfulResume: checks summary/skills/exp/edu
 *   backend/src/__tests__/setup.ts               — MongoMemoryServer global setup
 *   backend/src/__tests__/kda-d.adversarial.test.ts — harness pattern: app setup, currentUserId
 *                                                   mutable, collection.insertOne for raw docs
 *   backend/src/__tests__/wallet.test.ts         — mockFetch pattern, createUser helper shape
 *   backend/src/__tests__/auth.test.ts           — express error handler pattern
 *   backend/src/__tests__/tracker.adversarial.test.ts — collection.insertOne to bypass Mongoose
 *
 * Files NOT opened (forbidden):
 *   backend/src/controllers/matchController.ts          ✓ not opened
 *   backend/src/__tests__/triggerMatch.test.ts          ✓ not opened
 *   backend/src/__tests__/triggerGate.adversarial.test.ts ✓ not opened
 *
 * Incidental disclosures (from grep/bash output, not file reads):
 *   - matchController.ts uses `process.env.BACKGROUND_SERVICE_URL || "http://localhost:5001"`
 *     and `process.env.INTERNAL_TRIGGER_SECRET`. Saw these in grep results searching for
 *     env var names. Used only to confirm variable names (already in the contract). The URL
 *     path "/internal/match-for-user" comes solely from the contract.
 *   - triggerGate.adversarial.test.ts (forbidden) appeared in grep output showing it sets
 *     BACKGROUND_SERVICE_URL and INTERNAL_TRIGGER_SECRET in beforeAll. No assertions from this.
 *
 * UNTESTABLE-WITHOUT-READING FINDINGS:
 *
 *   1. TEMPORAL RACE spy coverage: Tests TR-W1/TR-M1/TR-V1 depend on the handler using
 *      `User.findById` for the snapshot read. If the handler uses `User.findOne({_id: id})`
 *      instead, the spy does not intercept it, and the test fails for the wrong reason — the
 *      real (ineligible) DB doc is read at snapshot time, so the snapshot gate fires rather
 *      than the atomic re-check. This would make the test a false negative: it would pass
 *      (correct status returned) but not because the atomic claim caught the race.
 *      DIAGNOSTIC: if TR-* tests fail with an unexpected status and mockFetch call count of 0,
 *      check whether findById or findOne is used for the snapshot.
 *
 *   2. findById chain compatibility: If the handler calls `User.findById(id).select(...)`
 *      or `.lean()` after the findById call, the makeMockQuery Proxy handles this via the
 *      catch-all getter. If it fails with "select is not a function" or similar, the
 *      Proxy is insufficient and a more complete mock is needed. Report as a finding if
 *      TR-* tests fail with TypeError rather than an assertion error.
 *
 *   3. 503 timing vs atomic claim: The contract says INTERNAL_TRIGGER_SECRET is checked
 *      "then" after snapshot gates, but doesn't specify if it's before or after the atomic
 *      claim. SC-3 asserts lastManualMatchAt is NOT advanced. If the atomic claim fires
 *      before the secret check, the claim result (null or matched doc) must be rolled back
 *      if the 503 path is taken — which is a finding if SC-3 fails.
 *
 *   4. Rollback mechanism transparency: DF-1 through DF-4 verify observable DB state only.
 *      Whether rollback is implemented as an explicit $set write, a conditional update, or
 *      a transaction cannot be verified from outside. DF-2 is the most discriminating test:
 *      if lastManualMatchAt ends up as "now" instead of the original sevenHoursAgo value,
 *      that proves the rollback is absent or broken.
 * ══════════════════════════════════════════════════════════════════════════════
 */
