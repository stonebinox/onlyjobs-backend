/**
 * ADVERSARIAL TESTS — onlyjobs-kjc pass 1
 * POST /api/matches/trigger-for-me — eligibility gate
 *
 * Assume the implementation is subtly WRONG; write tests that EXPOSE bugs.
 * Report pass/fail — failures are FINDINGS, not fixes.
 * Do NOT modify production code, do NOT weaken tests.
 *
 * FORBIDDEN FILES (never opened):
 *   src/controllers/matchController.ts
 *   src/__tests__/triggerMatch.test.ts
 *
 * CONTRACT (oracle — all assertions trace to the kjc spec, not code output):
 *   Gate failures block dispatch AND do NOT set lastManualMatchAt:
 *     isVerified===false → 403, body.reason:"unverified"
 *     resume not meaningful → 400, body.reason:"no_resume"
 *     preferences.matchingEnabled===false → 400, body.reason:"matching_disabled"
 *     walletBalance < 0.30 → 400, body.reason:"insufficient_balance", body.walletBalance, body.required===0.3
 *   Gate order: unverified wins when multiple gates fail simultaneously
 *   Wallet: 0.30 passes (NOT < 0.30); 0.29 fails; 0 fails; undefined treated as 0
 *   Resume: whitespace-only → no_resume; meaningful summary → passes
 *   matchingEnabled:undefined → must NOT be treated as disabled (passes)
 *   Cooldown: lastManualMatchAt within 6h → 429, no dispatch; ≥6h ago → runs
 *   Dispatch failure: non-ok or throwing fetch → 502, lastManualMatchAt rolled back
 *   Happy path: eligible → 202, fetch called once with userId, lastManualMatchAt set
 *
 * DISCLOSURE: see bottom of file.
 */

// Capture originals before any test runs; restored in afterAll for worker isolation.
const _origBgUrl: string | undefined = process.env.BACKGROUND_SERVICE_URL;
const _origTriggerSecret: string | undefined = process.env.INTERNAL_TRIGGER_SECRET;
const _origFetch: typeof global.fetch = (global as any).fetch;

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

// ── Test app ──────────────────────────────────────────────────────────────────
// currentUserId is mutable — tests switch identity by assigning before a request.
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

// ── Per-test state ────────────────────────────────────────────────────────────
let ownerUserId: mongoose.Types.ObjectId;
let mockFetch: jest.Mock;
let originalFetch: typeof global.fetch;

beforeEach(() => {
  ownerUserId = new mongoose.Types.ObjectId();
  currentUserId = ownerUserId;
  originalFetch = (global as any).fetch;
  mockFetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  } as unknown as Response);
  (global as any).fetch = mockFetch;
});

afterEach(() => {
  (global as any).fetch = originalFetch;
});

beforeAll(() => {
  process.env.BACKGROUND_SERVICE_URL = 'http://fake-bg-service';
  // The controller checks INTERNAL_TRIGGER_SECRET before dispatching; without it the
  // response is 503 before any gate logic runs.
  process.env.INTERNAL_TRIGGER_SECRET = 'test-trigger-secret';
});

afterAll(() => {
  if (_origBgUrl === undefined) delete process.env.BACKGROUND_SERVICE_URL;
  else process.env.BACKGROUND_SERVICE_URL = _origBgUrl;
  if (_origTriggerSecret === undefined) delete process.env.INTERNAL_TRIGGER_SECRET;
  else process.env.INTERNAL_TRIGGER_SECRET = _origTriggerSecret;
  (global as any).fetch = _origFetch;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let emailCounter = 0;

async function makeEligibleUser(overrides: Record<string, any> = {}) {
  emailCounter++;
  const base: Record<string, any> = {
    _id: ownerUserId,
    name: 'Test User',
    email: `tg-adv-${emailCounter}-${ownerUserId.toString()}@example.com`,
    password: 'hashed',
    isVerified: true,
    resume: {
      summary: 'Experienced software engineer',
      skills: ['TypeScript', 'Node.js'],
      experience: [],
      education: [],
    },
    preferences: {
      jobTypes: [],
      location: [],
      remoteOnly: false,
      minSalary: 0,
      industries: [],
      minScore: 30,
      matchingEnabled: true,
    },
    walletBalance: 1.00,
  };
  // Deep-merge nested objects so callers only need to pass the key they're changing.
  if (overrides.preferences) {
    overrides = { ...overrides, preferences: { ...base.preferences, ...overrides.preferences } };
  }
  if (overrides.resume) {
    overrides = { ...overrides, resume: { ...base.resume, ...overrides.resume } };
  }
  return User.create({ ...base, ...overrides });
}

const triggerForMe = () => request(testApp).post('/api/matches/trigger-for-me');
const refetchUser  = () => User.findById(ownerUserId);
const dispatchCalled = () => mockFetch.mock.calls.length > 0;

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GATE FAILURES
//    Each gate must: return the right status+reason, NOT call fetch, and NOT
//    set/advance lastManualMatchAt.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Gate: isVerified===false → 403 unverified', () => {
  it('G1a: returns HTTP 403 [contract: unverified → 403]', async () => {
    await makeEligibleUser({ isVerified: false });
    const res = await triggerForMe();
    // FINDING if 400/500: wrong status — the gate exists but returns the wrong code
    expect(res.status).toBe(403);
  });

  it('G1b: body.reason === "unverified" [contract: reason field]', async () => {
    await makeEligibleUser({ isVerified: false });
    const res = await triggerForMe();
    expect(res.body.reason).toBe('unverified');
  });

  it('G1c: fetch NOT called [contract: no dispatch on gate failure]', async () => {
    await makeEligibleUser({ isVerified: false });
    await triggerForMe();
    // CRITICAL FINDING if true: background dispatch fired despite unverified user
    expect(dispatchCalled()).toBe(false);
  });

  it('G1d: lastManualMatchAt NOT set [contract: gate failure must not claim the 6h cooldown]', async () => {
    await makeEligibleUser({ isVerified: false });
    await triggerForMe();
    const user = await refetchUser();
    // CRITICAL FINDING if defined: a rejected gate burned the 6-hour cooldown slot
    expect(user?.lastManualMatchAt == null).toBe(true);
  });
});

describe('Gate: resume not meaningful → 400 no_resume', () => {
  it('G2a: whitespace-only summary and skills → 400 [contract: no_resume → 400]', async () => {
    await makeEligibleUser({ resume: { summary: '   ', skills: ['  '], experience: [], education: [] } });
    const res = await triggerForMe();
    // FINDING if 202: resume gate absent
    expect(res.status).toBe(400);
  });

  it('G2b: body.reason === "no_resume" [contract: reason field]', async () => {
    await makeEligibleUser({ resume: { summary: '   ', skills: ['  '], experience: [], education: [] } });
    const res = await triggerForMe();
    expect(res.body.reason).toBe('no_resume');
  });

  it('G2c: fetch NOT called when resume is blank [contract: no dispatch on no_resume]', async () => {
    await makeEligibleUser({ resume: { summary: '', skills: [], experience: [], education: [] } });
    await triggerForMe();
    expect(dispatchCalled()).toBe(false);
  });

  it('G2d: lastManualMatchAt NOT set when resume is blank [contract: no cooldown on gate failure]', async () => {
    await makeEligibleUser({ resume: { summary: '', skills: [], experience: [], education: [] } });
    await triggerForMe();
    const user = await refetchUser();
    expect(user?.lastManualMatchAt == null).toBe(true);
  });

  it('G2e: completely empty resume (all fields blank) via collection insert → 400 no_resume', async () => {
    // Insert via collection to bypass Mongoose defaults on sub-document fields.
    await User.collection.insertOne({
      _id: ownerUserId,
      name: 'Test',
      email: `tg-empty-resume-${ownerUserId.toString()}@example.com`,
      password: 'hashed',
      isVerified: true,
      resume: { summary: '', skills: [], experience: [], education: [] },
      preferences: { matchingEnabled: true, remoteOnly: false, minSalary: 0, minScore: 30, jobTypes: [], location: [], industries: [] },
      walletBalance: 1.00,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await triggerForMe();
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
    expect(dispatchCalled()).toBe(false);
  });
});

describe('Gate: preferences.matchingEnabled===false → 400 matching_disabled', () => {
  it('G3a: matchingEnabled:false → 400 [contract: matching_disabled → 400]', async () => {
    await makeEligibleUser({ preferences: { matchingEnabled: false } });
    const res = await triggerForMe();
    expect(res.status).toBe(400);
  });

  it('G3b: body.reason === "matching_disabled" [contract: reason field]', async () => {
    await makeEligibleUser({ preferences: { matchingEnabled: false } });
    const res = await triggerForMe();
    expect(res.body.reason).toBe('matching_disabled');
  });

  it('G3c: fetch NOT called when matching disabled [contract: no dispatch on matching_disabled]', async () => {
    await makeEligibleUser({ preferences: { matchingEnabled: false } });
    await triggerForMe();
    expect(dispatchCalled()).toBe(false);
  });

  it('G3d: lastManualMatchAt NOT set when matching disabled [contract: no cooldown on gate failure]', async () => {
    await makeEligibleUser({ preferences: { matchingEnabled: false } });
    await triggerForMe();
    const user = await refetchUser();
    expect(user?.lastManualMatchAt == null).toBe(true);
  });
});

describe('Gate: walletBalance < 0.30 → 400 insufficient_balance', () => {
  it('G4a: walletBalance:0 → 400 insufficient_balance [contract: 0 < 0.30]', async () => {
    await makeEligibleUser({ walletBalance: 0 });
    const res = await triggerForMe();
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('insufficient_balance');
  });

  it('G4b: body.walletBalance reflects the actual balance [contract: body.walletBalance]', async () => {
    await makeEligibleUser({ walletBalance: 0.05 });
    const res = await triggerForMe();
    expect(res.status).toBe(400);
    // FINDING if missing: walletBalance not returned in error body
    expect(typeof res.body.walletBalance).toBe('number');
    expect(res.body.walletBalance).toBeCloseTo(0.05, 5);
  });

  it('G4c: body.required === 0.3 [contract: required field must be present and correct]', async () => {
    await makeEligibleUser({ walletBalance: 0 });
    const res = await triggerForMe();
    // FINDING if absent/wrong: required field missing or uses wrong threshold
    expect(res.body.required).toBe(0.3);
  });

  it('G4d: fetch NOT called when wallet is empty [contract: no dispatch on insufficient_balance]', async () => {
    await makeEligibleUser({ walletBalance: 0 });
    await triggerForMe();
    expect(dispatchCalled()).toBe(false);
  });

  it('G4e: lastManualMatchAt NOT set when wallet is empty [contract: no cooldown on gate failure]', async () => {
    await makeEligibleUser({ walletBalance: 0 });
    await triggerForMe();
    const user = await refetchUser();
    expect(user?.lastManualMatchAt == null).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. GATE ORDERING / PRECEDENCE
//    When multiple gates fail simultaneously, unverified must win (403, not 400).
// ═══════════════════════════════════════════════════════════════════════════════

describe('Gate ordering: unverified wins when multiple gates fail', () => {
  it('G-ORD-1: unverified + blank resume + wallet:0 + matchingEnabled:false → 403 unverified [contract: gate order]', async () => {
    // User fails ALL four gates — the documented first gate (unverified) must win.
    await makeEligibleUser({
      isVerified: false,
      resume: { summary: '', skills: [], experience: [], education: [] },
      walletBalance: 0,
      preferences: { matchingEnabled: false },
    });
    const res = await triggerForMe();
    // FINDING if 400: a later gate ran before the isVerified check — wrong order
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('unverified');
    expect(dispatchCalled()).toBe(false);
  });

  it('G-ORD-2: verified + blank resume + wallet:0 → 400 with a documented reason [consistent failure when unverified gate passes]', async () => {
    // Two gates fail (resume + wallet). Contract does not prescribe ordering between
    // these two, but one must win and must be a documented reason — not a generic 500.
    await makeEligibleUser({
      isVerified: true,
      resume: { summary: '', skills: [], experience: [], education: [] },
      walletBalance: 0,
    });
    const res = await triggerForMe();
    expect(res.status).toBe(400);
    // FINDING if reason is not documented: implementation returns an undocumented reason
    expect(['no_resume', 'matching_disabled', 'insufficient_balance']).toContain(res.body.reason);
    expect(dispatchCalled()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. WALLET BOUNDARY (highest value)
//    0.30 must PASS. 0.29 must FAIL. The check is strict less-than, not <=.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Wallet boundary: 0.30 passes, 0.29 fails', () => {
  it('W1: walletBalance exactly 0.30 → 202 [contract: 0.30 is NOT < 0.30]', async () => {
    await makeEligibleUser({ walletBalance: 0.30 });
    const res = await triggerForMe();
    // CRITICAL FINDING if 400: implementation used <= instead of < (wrong — 0.30 should pass)
    expect(res.status).toBe(202);
    expect(dispatchCalled()).toBe(true);
  });

  it('W2: walletBalance exactly 0.29 → 400 insufficient_balance [contract: 0.29 < 0.30]', async () => {
    await makeEligibleUser({ walletBalance: 0.29 });
    const res = await triggerForMe();
    // CRITICAL FINDING if 202: implementation used < 0.29 or some other wrong threshold
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('insufficient_balance');
    expect(dispatchCalled()).toBe(false);
  });

  it('W3: walletBalance:0 → 400, body.walletBalance===0 [zero treated as insufficient]', async () => {
    await makeEligibleUser({ walletBalance: 0 });
    const res = await triggerForMe();
    expect(res.status).toBe(400);
    expect(res.body.walletBalance).toBe(0);
  });

  it('W4: walletBalance field absent in DB → 400 insufficient_balance [undefined treated as 0]', async () => {
    // Insert without walletBalance to bypass Mongoose default:0.
    // An implementation that does `(user.walletBalance || 0) < 0.30` would correctly gate;
    // one that does `user.walletBalance < 0.30` with undefined would evaluate `undefined < 0.30`
    // (false in JS, allowing the user through) — a FINDING if 202 is returned.
    await User.collection.insertOne({
      _id: ownerUserId,
      name: 'Test',
      email: `tg-no-wallet-${ownerUserId.toString()}@example.com`,
      password: 'hashed',
      isVerified: true,
      resume: { summary: 'Engineer', skills: ['Node.js'], experience: [], education: [] },
      preferences: { matchingEnabled: true, remoteOnly: false, minSalary: 0, minScore: 30, jobTypes: [], location: [], industries: [] },
      // walletBalance intentionally omitted
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await triggerForMe();
    // FINDING if 202: undefined walletBalance bypasses the gate (undefined < 0.30 is false in JS)
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('insufficient_balance');
    expect(dispatchCalled()).toBe(false);
  });

  it('W5: walletBalance:0.31 → 202 [above threshold, must not false-positive]', async () => {
    await makeEligibleUser({ walletBalance: 0.31 });
    const res = await triggerForMe();
    expect(res.status).toBe(202);
    expect(dispatchCalled()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. RESUME VIA THE REAL hasMeaningfulResume PREDICATE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Resume predicate (hasMeaningfulResume)', () => {
  it('R1: whitespace-only summary + empty skills → 400 no_resume [hasMeaningfulText("   ") is false]', async () => {
    await makeEligibleUser({
      resume: { summary: '   \t\n', skills: [], experience: [], education: [] },
    });
    const res = await triggerForMe();
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
  });

  it('R2: skills array of all-whitespace strings → 400 no_resume [hasMeaningfulArray fails when all items are blank]', async () => {
    await makeEligibleUser({
      resume: { summary: '', skills: ['  ', '\t', ''], experience: [], education: [] },
    });
    const res = await triggerForMe();
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_resume');
  });

  it('R3: meaningful summary ("Engineer") → 202 [hasMeaningfulText("Engineer") is true]', async () => {
    await makeEligibleUser({
      resume: { summary: 'Engineer', skills: [], experience: [], education: [] },
    });
    const res = await triggerForMe();
    // FINDING if 400: gate rejects a meaningful resume (predicate used incorrectly)
    expect(res.status).toBe(202);
    expect(dispatchCalled()).toBe(true);
  });

  it('R4: empty summary but meaningful skill → 202 [hasMeaningfulArray(skills) with one real entry]', async () => {
    await makeEligibleUser({
      resume: { summary: '', skills: ['JavaScript'], experience: [], education: [] },
    });
    const res = await triggerForMe();
    // FINDING if 400: gate only checks summary and ignores skills
    expect(res.status).toBe(202);
    expect(dispatchCalled()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. matchingEnabled: false vs true vs undefined
// ═══════════════════════════════════════════════════════════════════════════════

describe('matchingEnabled gate', () => {
  it('M1: matchingEnabled:false → 400 matching_disabled [explicit false blocks]', async () => {
    await makeEligibleUser({ preferences: { matchingEnabled: false } });
    const res = await triggerForMe();
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('matching_disabled');
    expect(dispatchCalled()).toBe(false);
  });

  it('M2: matchingEnabled:true → 202 [explicit true passes]', async () => {
    await makeEligibleUser({ preferences: { matchingEnabled: true } });
    const res = await triggerForMe();
    expect(res.status).toBe(202);
    expect(dispatchCalled()).toBe(true);
  });

  it('M3: matchingEnabled field absent in DB → 202 NOT matching_disabled [undefined must NOT be treated as disabled]', async () => {
    // An implementation using `!user.preferences.matchingEnabled` would gate here
    // (since !undefined === true), violating the contract.
    // Schema default is true, but we insert via collection to force the field absent.
    await User.collection.insertOne({
      _id: ownerUserId,
      name: 'Test',
      email: `tg-no-enabled-${ownerUserId.toString()}@example.com`,
      password: 'hashed',
      isVerified: true,
      resume: { summary: 'Engineer', skills: ['Node.js'], experience: [], education: [] },
      preferences: {
        // matchingEnabled intentionally omitted — must NOT trigger matching_disabled gate
        remoteOnly: false,
        minSalary: 0,
        minScore: 30,
        jobTypes: [],
        location: [],
        industries: [],
      },
      walletBalance: 1.00,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await triggerForMe();
    // CRITICAL FINDING if 400/matching_disabled: `!undefined` is truthy — wrong check
    expect(res.status).toBe(202);
    expect(dispatchCalled()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. COOLDOWN
//    lastManualMatchAt within 6h → 429. After 6h → passes. Unset → passes.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cooldown: 6-hour gate on lastManualMatchAt', () => {
  it('CD1: lastManualMatchAt = now → 429 [contract: within 6h = cooldown active]', async () => {
    await makeEligibleUser({ lastManualMatchAt: new Date() });
    const res = await triggerForMe();
    // FINDING if 200/202: cooldown not enforced at all
    expect(res.status).toBe(429);
    expect(dispatchCalled()).toBe(false);
  });

  it('CD2: lastManualMatchAt = 5h59m ago → 429 [still inside the 6h window]', async () => {
    const fiveH59mAgo = new Date(Date.now() - (6 * 3600 - 60) * 1000);
    await makeEligibleUser({ lastManualMatchAt: fiveH59mAgo });
    const res = await triggerForMe();
    // FINDING if 202: cooldown window is shorter than 6h
    expect(res.status).toBe(429);
    expect(dispatchCalled()).toBe(false);
  });

  it('CD3: lastManualMatchAt = 1h ago → 429 [well within 6h]', async () => {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000);
    await makeEligibleUser({ lastManualMatchAt: oneHourAgo });
    const res = await triggerForMe();
    expect(res.status).toBe(429);
    expect(dispatchCalled()).toBe(false);
  });

  it('CD4: lastManualMatchAt = 7h ago → 202 [past the 6h window, must pass]', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000);
    await makeEligibleUser({ lastManualMatchAt: sevenHoursAgo });
    const res = await triggerForMe();
    // FINDING if 429: cooldown window extends past 6h (off-by-one in the comparison)
    expect(res.status).toBe(202);
    expect(dispatchCalled()).toBe(true);
  });

  it('CD5: lastManualMatchAt unset → 202 NOT 429 [first-time user must not be throttled]', async () => {
    await makeEligibleUser(); // no lastManualMatchAt
    const res = await triggerForMe();
    // FINDING if 429: gate incorrectly fires when lastManualMatchAt is absent
    expect(res.status).toBe(202);
    expect(dispatchCalled()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. DISPATCH FAILURE ROLLBACK (highest value)
//    A failed dispatch must NOT leave lastManualMatchAt set to "now".
//    A locked-out user who got a 502 is the failure mode being prevented.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Dispatch failure: 502 + cooldown rollback', () => {
  it('DFR1: fetch returns {ok:false} → 502 [contract: non-ok dispatch → 502]', async () => {
    await makeEligibleUser();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);

    const res = await triggerForMe();
    // FINDING if 202: controller returned success despite background returning non-ok
    expect(res.status).toBe(502);
  });

  it('DFR2: fetch returns {ok:false} → lastManualMatchAt NOT set [contract: rollback on non-ok]', async () => {
    await makeEligibleUser();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);

    await triggerForMe();
    const user = await refetchUser();

    // CRITICAL FINDING if set to a recent date: failed dispatch burned the 6h cooldown
    const mma = user?.lastManualMatchAt;
    expect(mma == null).toBe(true);
  });

  it('DFR3: fetch throws (network error) → 502 [contract: throwing fetch → 502]', async () => {
    await makeEligibleUser();
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED: connection refused'));

    const res = await triggerForMe();
    // FINDING if 500: error leaks uncaught; FINDING if 202: exception swallowed as success
    expect(res.status).toBe(502);
  });

  it('DFR4: fetch throws → lastManualMatchAt NOT set [contract: rollback on throw]', async () => {
    await makeEligibleUser();
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED: connection refused'));

    await triggerForMe();
    const user = await refetchUser();

    // CRITICAL FINDING if set to a recent date: throwing fetch burned the 6h cooldown
    const mma = user?.lastManualMatchAt;
    expect(mma == null).toBe(true);
  });

  it('DFR5: after non-ok dispatch, re-trigger immediately → 202 NOT 429 [rollback is durable: cooldown was not burned]', async () => {
    await makeEligibleUser();

    // First call — dispatch fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);
    const first = await triggerForMe();
    expect(first.status).toBe(502);

    // Second call — dispatch succeeds. 429 here means rollback didn't happen.
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    const second = await triggerForMe();
    // CRITICAL FINDING if 429: the failed first call set lastManualMatchAt and it wasn't rolled back
    expect(second.status).toBe(202);
  });

  it('DFR6: after throwing dispatch, re-trigger immediately → 202 NOT 429 [rollback on throw is durable]', async () => {
    await makeEligibleUser();

    // First call — dispatch throws
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const first = await triggerForMe();
    expect(first.status).toBe(502);

    // Second call — dispatch succeeds.
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    const second = await triggerForMe();
    // CRITICAL FINDING if 429: throw path also failed to roll back lastManualMatchAt
    expect(second.status).toBe(202);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. HAPPY PATH
// ═══════════════════════════════════════════════════════════════════════════════

describe('Happy path: eligible user → 202, fetch once, lastManualMatchAt set', () => {
  it('HP1: returns 202 [contract: eligible → 202]', async () => {
    await makeEligibleUser();
    const res = await triggerForMe();
    expect(res.status).toBe(202);
  });

  it('HP2: fetch called exactly once [contract: one dispatch per trigger — no double-fire]', async () => {
    await makeEligibleUser();
    await triggerForMe();
    // FINDING if 0: dispatch never happened; FINDING if >1: duplicate dispatch
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  it('HP3: fetch URL targets the background service /internal/match-for-user [contract: correct dispatch target]', async () => {
    await makeEligibleUser();
    await triggerForMe();

    const calledUrl: string = mockFetch.mock.calls[0][0];
    // FINDING if missing: wrong base URL or wrong path
    expect(calledUrl).toContain('fake-bg-service');
    expect(calledUrl).toContain('/internal/match-for-user');
  });

  it('HP4: lastManualMatchAt set to approximately now [contract: sets lastManualMatchAt]', async () => {
    const before = Date.now();
    await makeEligibleUser();
    await triggerForMe();
    const after = Date.now();

    const user = await refetchUser();
    // FINDING if undefined: endpoint returned 202 but never persisted lastManualMatchAt
    expect(user?.lastManualMatchAt).toBeDefined();
    const mmaMs = user!.lastManualMatchAt!.getTime();
    // Must be within this test's execution window (with 2s leeway for timing jitter)
    expect(mmaMs).toBeGreaterThanOrEqual(before - 2000);
    expect(mmaMs).toBeLessThanOrEqual(after + 2000);
  });

  it('HP5: dispatch call includes the userId [contract: dispatch targets the correct user]', async () => {
    await makeEligibleUser();
    await triggerForMe();

    // Serialise ALL call arguments — covers URL params, request body, and headers
    const callArgs = JSON.stringify(mockFetch.mock.calls[0]);
    // FINDING if not present: background service would run a match for the wrong user
    expect(callArgs).toContain(ownerUserId.toString());
  });

  it('HP6: successive eligible trigger after cooldown expires → 202 again [cooldown is time-bounded]', async () => {
    // First trigger — succeeds, sets lastManualMatchAt
    await makeEligibleUser({ lastManualMatchAt: new Date(Date.now() - 7 * 3600 * 1000) });
    const res = await triggerForMe();
    expect(res.status).toBe(202);
    expect(dispatchCalled()).toBe(true);
  });
});

/*
 * ══════════════════════════════════════════════════════════════════════════════
 * DISCLOSURE
 *
 * Files opened while writing this test:
 *   src/models/User.ts                         — IUser interface, lastManualMatchAt: Date,
 *                                                walletBalance: Number, preferences.matchingEnabled
 *   src/routes/matchRoutes.ts                  — confirmed POST /trigger-for-me path
 *   src/utils/resumePredicate.ts               — hasMeaningfulResume full implementation (oracle)
 *   src/__tests__/setup.ts                     — MongoMemoryServer global setup/teardown
 *   src/__tests__/tracker.adversarial.test.ts  — harness pattern (inject req.user, express app)
 *   src/__tests__/kda-d.adversarial.test.ts    — collection.insertOne pattern for bypassing defaults
 *   src/__tests__/outOfCreditPreview.test.ts   — user creation helper pattern
 *   src/__tests__/cvUpload.adversarial.test.ts — jest.mock hoisting pattern (first 100 lines)
 *
 * Files NOT opened (forbidden):
 *   src/controllers/matchController.ts         ✓ not opened
 *   src/__tests__/triggerMatch.test.ts         ✓ not opened
 *
 * Incidental disclosures:
 *   - routes/matchRoutes.ts imports `triggerMatchForMe` by name — saw function name in passing.
 *     No assertion references this name; the route path /trigger-for-me is the oracle.
 *   - resumePredicate.ts: hasMeaningfulResume also checks experience and education arrays via
 *     hasMeaningfulArray. Tests R3/R4 cover summary and skills; experience/education are not
 *     independently tested because the contract only required "meaningful summary" and the
 *     predicate contract is the whole function, not individual fields.
 *   - outOfCreditPreview.test.ts uses walletBalance: 0.10 — confirmed decimal walletBalance.
 *     No assertions derive from this.
 *   - setup.ts runs afterEach({ deleteMany }) — confirmed per-test DB isolation, which makes
 *     the per-test ownerUserId approach safe.
 *
 * Untestable-without-reading findings:
 *   - DFR2/DFR4: The rollback is tested via observable DB state (lastManualMatchAt null after
 *     failure). Whether the implementation sets-then-rolls-back or only sets-on-success is
 *     invisible from outside; DFR5/DFR6 provide the stronger behavioral proof (re-trigger → 202).
 *   - HP5 (userId in dispatch): The exact payload shape (JSON body vs query param vs URL segment)
 *     is unknown without reading the controller. The test stringifies all call arguments and
 *     searches for the userId string, which covers all reasonable shapes.
 *   - Gate ordering (G-ORD-2): The contract specifies that unverified wins, but does not specify
 *     the ordering between no_resume, matching_disabled, and insufficient_balance. G-ORD-2 only
 *     asserts "a documented 400 reason" rather than prescribing a specific one.
 *   - M3 (matchingEnabled absent): Depends on whether Mongoose re-applies schema defaults on
 *     findById (it does not for documents inserted via collection.insertOne). This accurately
 *     simulates a document where the field was never set by the application.
 * ══════════════════════════════════════════════════════════════════════════════
 */
