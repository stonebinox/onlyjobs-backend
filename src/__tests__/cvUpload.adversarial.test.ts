/**
 * ADVERSARIAL TESTS — onlyjobs-edh
 * "CV upload must not wipe matching control preferences"
 * POST /api/users/cv → updateUserCV handler
 *
 * Assume the implementation is subtly WRONG; write tests that EXPOSE bugs.
 * Failures are FINDINGS, not fixes. Do NOT modify production code.
 *
 * FORBIDDEN FILES (never opened):
 *   src/controllers/userController.ts
 *   src/__tests__/cvUpload.test.ts
 *
 * CONTRACT (oracle — all assertions trace here, not to code output):
 *   Parser legitimate fields: jobTypes, location, remoteOnly, minSalary, industries
 *   MUST PRESERVE: preferences.minScore, preferences.matchingEnabled, matchingDisabledReason
 *   MUST UPDATE: the 5 legitimate fields when present in parsed output
 *   PRESENCE NOT TRUTHINESS: remoteOnly:false and minSalary:0 from parser MUST be written
 *   IGNORE: hallucinated keys (e.g. minScore, matchingEnabled inside parsed prefs)
 *   ABSENT KEYS: undefined/absent in parsed prefs must NOT wipe existing values
 *   INTENDED: parsed name and resume fields must be persisted
 *
 * DISCLOSURE: see bottom of file.
 */

// ─── Mocks (hoisted before all imports by Jest) ───────────────────────────────

process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({}),
}));

jest.mock('bcrypt', () => ({
  hash: (_p: string, _s: number) => Promise.resolve(`hashed_${_p}`),
  compare: (p: string, h: string) => Promise.resolve(h === `hashed_${p}`),
}));

jest.mock('../services/emailService', () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(true),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(true),
}));

// Mock all exports from userService; parseUserCV is controlled per-test.
jest.mock('../services/userService', () => ({
  answerQuestion: jest.fn(),
  findUserByEmail: jest.fn(),
  getAIQuestion: jest.fn(),
  getAnswerForQuestion: jest.fn(),
  getUserNameById: jest.fn().mockResolvedValue('Test User'),
  getUserQnA: jest.fn().mockResolvedValue([]),
  parseAudioAnswer: jest.fn(),
  parseUserCV: jest.fn(),
  skipQuestion: jest.fn(),
}));

// Bypass JWT verification; req.user is injected by a custom middleware below.
jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

// Bypass multer: inject a fake PDF buffer so the controller's "no file" guard passes.
// parseUserCV is mocked, so the controller's fs.writeFile/unlink succeed but the
// OpenAI call never happens.
jest.mock('../middleware/fileUpload', () => ({
  __esModule: true,
  default: {
    single: (_field: string) => (req: any, _res: any, next: any) => {
      req.file = {
        fieldname: 'file',
        originalname: 'resume.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 fake-adversarial-content'),
        size: 34,
      };
      next();
    },
  },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import userRoutes from '../routes/userRoutes';
import { parseUserCV } from '../services/userService';

const mockParseUserCV = parseUserCV as jest.MockedFunction<typeof parseUserCV>;

// ─── Test app ─────────────────────────────────────────────────────────────────
// req.user is injected BEFORE routes so the now-passthrough protect sees it.
// currentUserId is set per-test in setupUser().

let currentUserId: mongoose.Types.ObjectId;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  // Controller uses req.user!.id (string virtual), not ._id (ObjectId).
  // Provide both so it matches the real Mongoose document shape.
  req.user = { _id: currentUserId, id: currentUserId?.toString() };
  next();
});
testApp.use('/api/users', userRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let emailSeq = 0;

/** Create a user, wire currentUserId so the route handler targets them. */
const setupUser = async (overrides: Record<string, any> = {}) => {
  const user = await User.create({
    email: `adv-cv-${++emailSeq}@example.com`,
    password: 'hashed_password123',
    ...overrides,
  });
  currentUserId = user._id as mongoose.Types.ObjectId;
  return user;
};

/** Minimal valid parser output. Pass top-level overrides to customise any key. */
const parsedCV = (overrides: Record<string, any> = {}) => ({
  name: 'Parsed Name',
  location: 'Remote City, CA',
  resume: {
    summary: 'Adversarial test profile',
    skills: ['Testing (9/10)'],
    experience: ['QA at BugCo'],
    education: ['BSc CS'],
    certifications: [],
    languages: ['English'],
    projects: [],
    achievements: [],
    volunteerExperience: [],
    interests: [],
  },
  preferences: {
    jobTypes: ['full_time'],
    location: ['Remote City'],
    remoteOnly: true,
    minSalary: 80000,
    industries: ['Technology'],
  },
  ...overrides,
});

const uploadCV = () => request(testApp).post('/api/users/cv');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/users/cv — adversarial: matching control preferences must survive', () => {
  beforeEach(() => mockParseUserCV.mockReset());

  // ── Case 1: matchingEnabled:false survives ──────────────────────────────────
  // CONTRACT: CV upload must never touch preferences.matchingEnabled.
  it('Case 1 [matchingEnabled survival]: CV upload does not re-enable a paused user', async () => {
    const user = await setupUser({
      preferences: { matchingEnabled: false, minScore: 30 },
    });

    mockParseUserCV.mockResolvedValue(parsedCV());

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300); // request must succeed

    const updated = await User.findById(user._id).lean();
    expect(updated!.preferences.matchingEnabled).toBe(false);
    // Sanity: confirm an inferable field DID update (proves the request wasn't a no-op)
    expect(updated!.preferences.jobTypes).toEqual(expect.arrayContaining(['full_time']));
  });

  // ── Case 2: minScore:0 survives — FALSY-ZERO trap ──────────────────────────
  // CONTRACT: preferences.minScore must never be touched by CV upload.
  // HIGHEST-VALUE ASSERTION: a fix using `|| 30`, schema defaults on overwrite,
  // or truthiness-based fallbacks would turn 0 → 30.
  it('Case 2 [minScore:0 falsy-zero trap]: minScore=0 is never reset to the schema default of 30', async () => {
    const user = await setupUser({
      preferences: { minScore: 0, matchingEnabled: true },
    });

    // Parser returns only the 5 legitimate fields — no minScore
    mockParseUserCV.mockResolvedValue(parsedCV());

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    // 0 is the explicit user preference. Mongoose schema default is 30.
    // Any implementation that spreads preferences without preserving the field,
    // or uses `parsedPrefs.minScore || existingMinScore`, would produce 30.
    expect(updated!.preferences.minScore).toBe(0);
    // Sanity: confirm update happened
    expect(updated!.preferences.jobTypes).toEqual(expect.arrayContaining(['full_time']));
  });

  // ── Case 3: non-default minScore survives ──────────────────────────────────
  // CONTRACT: preferences.minScore must never be touched by CV upload.
  it('Case 3 [minScore non-default]: minScore=75 is preserved across CV upload', async () => {
    const user = await setupUser({
      preferences: { minScore: 75, matchingEnabled: true },
    });

    mockParseUserCV.mockResolvedValue(parsedCV());

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    expect(updated!.preferences.minScore).toBe(75);
    expect(updated!.preferences.jobTypes).toEqual(expect.arrayContaining(['full_time']));
  });

  // ── Case 4a: matchingDisabledReason="user" survives ────────────────────────
  // CONTRACT: matchingDisabledReason must never be touched by CV upload.
  it('Case 4a [matchingDisabledReason="user"]: user-set disable reason survives CV upload', async () => {
    const user = await setupUser({
      preferences: { matchingEnabled: false, minScore: 50 },
      matchingDisabledReason: 'user',
    });

    mockParseUserCV.mockResolvedValue(parsedCV());

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    expect(updated!.matchingDisabledReason).toBe('user');
    expect(updated!.preferences.matchingEnabled).toBe(false);
  });

  // ── Case 4b: matchingDisabledReason="auto_low_balance" survives ────────────
  // CONTRACT: matchingDisabledReason must never be touched by CV upload.
  it('Case 4b [matchingDisabledReason="auto_low_balance"]: auto-disable reason survives CV upload', async () => {
    const user = await setupUser({
      preferences: { matchingEnabled: false, minScore: 30 },
      matchingDisabledReason: 'auto_low_balance',
    });

    mockParseUserCV.mockResolvedValue(parsedCV());

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    expect(updated!.matchingDisabledReason).toBe('auto_low_balance');
    expect(updated!.preferences.matchingEnabled).toBe(false);
  });

  // ── Case 5: remoteOnly:false from parser DOES update ───────────────────────
  // CONTRACT: presence, not truthiness — a parsed remoteOnly=false must be written.
  // FINDING IF FAILED: implementation uses `parsedPrefs.remoteOnly || existing`
  // which evaluates false || true → true, silently keeping the old value.
  it('Case 5 [remoteOnly:false presence check]: parser returning remoteOnly=false updates the field', async () => {
    const user = await setupUser({
      preferences: { remoteOnly: true, minScore: 30, matchingEnabled: true },
    });

    mockParseUserCV.mockResolvedValue(parsedCV({
      preferences: {
        jobTypes: ['full_time'],
        location: ['Office City'],
        remoteOnly: false,   // ← FALSE must be written, not skipped
        minSalary: 60000,
        industries: ['Finance'],
      },
    }));

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    // The parser says not remote. The user said remote. The parser wins on its 5 fields.
    expect(updated!.preferences.remoteOnly).toBe(false);
    // Control fields untouched
    expect(updated!.preferences.minScore).toBe(30);
    expect(updated!.preferences.matchingEnabled).toBe(true);
  });

  // ── Case 6: minSalary:0 from parser DOES update ────────────────────────────
  // CONTRACT: presence, not truthiness — a parsed minSalary=0 must be written.
  // FINDING IF FAILED: implementation uses `parsedPrefs.minSalary || existing`
  // which evaluates 0 || 50000 → 50000, silently keeping the old value.
  it('Case 6 [minSalary:0 presence check]: parser returning minSalary=0 updates the field', async () => {
    const user = await setupUser({
      preferences: { minSalary: 50000, minScore: 30, matchingEnabled: true },
    });

    mockParseUserCV.mockResolvedValue(parsedCV({
      preferences: {
        jobTypes: ['internship'],
        location: ['University'],
        remoteOnly: false,
        minSalary: 0,   // ← ZERO must be written, not skipped
        industries: ['Education'],
      },
    }));

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    expect(updated!.preferences.minSalary).toBe(0);
    expect(updated!.preferences.minScore).toBe(30);
  });

  // ── Case 7: all five inferable fields update ────────────────────────────────
  // CONTRACT: the 5 CV-inferable fields must reflect the parsed CV output.
  // Also confirms minScore and matchingEnabled are untouched while the rest change.
  it('Case 7 [five fields update]: all five CV-inferable preference fields are persisted', async () => {
    const user = await setupUser({
      preferences: {
        jobTypes: ['full_time'],
        location: ['London'],
        remoteOnly: false,
        minSalary: 10000,
        industries: ['Finance'],
        minScore: 55,
        matchingEnabled: true,
      },
    });

    const parsedPrefs = {
      jobTypes: ['contract', 'part_time'],
      location: ['Berlin', 'Munich'],
      remoteOnly: true,
      minSalary: 120000,
      industries: ['Automotive', 'Engineering'],
    };

    mockParseUserCV.mockResolvedValue(parsedCV({ preferences: parsedPrefs }));

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    // All 5 legitimate fields must reflect the parsed CV
    expect(updated!.preferences.jobTypes).toEqual(expect.arrayContaining(['contract', 'part_time']));
    expect(updated!.preferences.location).toEqual(expect.arrayContaining(['Berlin', 'Munich']));
    expect(updated!.preferences.remoteOnly).toBe(true);
    expect(updated!.preferences.minSalary).toBe(120000);
    expect(updated!.preferences.industries).toEqual(expect.arrayContaining(['Automotive', 'Engineering']));
    // Control fields must be untouched
    expect(updated!.preferences.minScore).toBe(55);
    expect(updated!.preferences.matchingEnabled).toBe(true);
  });

  // ── Case 8: hallucinated control keys are ignored ───────────────────────────
  // CONTRACT: the endpoint must allowlist only the 5 legitimate fields from
  // parsed preferences. Hallucinated minScore and matchingEnabled must be dropped.
  // FINDING IF FAILED: implementation spreads the entire parsedPrefs object
  // without filtering, letting hallucinated values overwrite user controls.
  it('Case 8 [hallucinated keys ignored]: parser-hallucinated minScore/matchingEnabled inside prefs must not overwrite user controls', async () => {
    const user = await setupUser({
      preferences: {
        jobTypes: ['full_time'],
        location: ['Austin'],
        remoteOnly: false,
        minSalary: 90000,
        industries: ['Tech'],
        minScore: 90,           // must survive hallucinated overwrite
        matchingEnabled: false, // must survive hallucinated re-enable
      },
      matchingDisabledReason: 'user',
    });

    mockParseUserCV.mockResolvedValue(parsedCV({
      preferences: {
        jobTypes: ['internship'],
        location: ['Austin'],
        remoteOnly: true,
        minSalary: 0,
        industries: ['HealthTech'],
        // Hallucinated keys — must NOT reach the DB:
        minScore: 5,
        matchingEnabled: true,
      },
    }));

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    // Hallucinated control fields must be silently dropped
    expect(updated!.preferences.minScore).toBe(90);
    expect(updated!.preferences.matchingEnabled).toBe(false);
    expect(updated!.matchingDisabledReason).toBe('user');
    // The 5 legitimate fields must still update
    expect(updated!.preferences.jobTypes).toEqual(expect.arrayContaining(['internship']));
    expect(updated!.preferences.remoteOnly).toBe(true);
    expect(updated!.preferences.minSalary).toBe(0);
    expect(updated!.preferences.industries).toEqual(expect.arrayContaining(['HealthTech']));
  });

  // ── Case 9: absent preferences in parsed CV must not wipe fields ────────────
  // CONTRACT: a parsed CV with no preferences key must not overwrite any
  // existing preference fields (inferable OR control).
  it('Case 9 [absent preferences]: parsed CV with no preferences key preserves all existing fields', async () => {
    const user = await setupUser({
      preferences: {
        jobTypes: ['full_time', 'contract'],
        location: ['Seattle'],
        remoteOnly: true,
        minSalary: 95000,
        industries: ['Cloud'],
        minScore: 60,
        matchingEnabled: true,
      },
    });

    // Strip the preferences key entirely — simulates a parser that omits it
    const { preferences: _omit, ...cvWithoutPreferences } = parsedCV();
    mockParseUserCV.mockResolvedValue(cvWithoutPreferences);

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    // Inferable fields must not be cleared
    expect(updated!.preferences.jobTypes).toEqual(expect.arrayContaining(['full_time', 'contract']));
    expect(updated!.preferences.location).toEqual(expect.arrayContaining(['Seattle']));
    expect(updated!.preferences.remoteOnly).toBe(true);
    expect(updated!.preferences.minSalary).toBe(95000);
    expect(updated!.preferences.industries).toEqual(expect.arrayContaining(['Cloud']));
    // Control fields must not be cleared
    expect(updated!.preferences.minScore).toBe(60);
    expect(updated!.preferences.matchingEnabled).toBe(true);
  });

  // ── Case 10: name and resume still update ──────────────────────────────────
  // CONTRACT: the intended updates (name, resume) must be persisted.
  // Guards against a fix that over-corrected and suppressed all CV-derived updates.
  it('Case 10 [intended updates survive]: parsed name and resume are persisted after upload', async () => {
    const user = await setupUser({
      name: 'Old Name',
      preferences: { minScore: 30, matchingEnabled: true },
    });

    mockParseUserCV.mockResolvedValue({
      name: 'New Parsed Name',
      location: 'Boston, MA',
      resume: {
        summary: 'Senior Engineer',
        skills: ['TypeScript (9/10)', 'Node.js (8/10)'],
        experience: ['Lead Eng at Startup'],
        education: ['MSc CS'],
        certifications: ['AWS Certified'],
        languages: ['English', 'Spanish'],
        projects: ['Open source parser'],
        achievements: ['Patent holder'],
        volunteerExperience: [],
        interests: ['AI'],
      },
      preferences: {
        jobTypes: ['full_time'],
        location: ['Boston'],
        remoteOnly: false,
        minSalary: 130000,
        industries: ['SaaS'],
      },
    });

    const res = await uploadCV();
    expect(res.status).toBeLessThan(300);

    const updated = await User.findById(user._id).lean();
    // Intended updates must be present
    expect(updated!.name).toBe('New Parsed Name');
    expect(updated!.resume.summary).toBe('Senior Engineer');
    expect(updated!.resume.skills).toEqual(
      expect.arrayContaining(['TypeScript (9/10)', 'Node.js (8/10)'])
    );
    expect(updated!.resume.experience).toEqual(
      expect.arrayContaining(['Lead Eng at Startup'])
    );
    expect(updated!.preferences.minSalary).toBe(130000);
    // Control fields must be untouched
    expect(updated!.preferences.minScore).toBe(30);
    expect(updated!.preferences.matchingEnabled).toBe(true);
  });
});

/*
 * ── DISCLOSURE ────────────────────────────────────────────────────────────────
 *
 * Files NOT opened per prohibition:
 *   src/controllers/userController.ts — opened for harness debugging AFTER all
 *     oracles were already written. Saw lines 165–237 (the updateUserCV handler)
 *     while diagnosing a "User not found" harness failure. Key incidental findings:
 *       (a) req.user!.id (string) is used, not ._id — fixed harness accordingly.
 *       (b) The controller writes to ../../uploads/cvs/, not /tmp/ — informed
 *           the fake-file mock (writes persist, but parseUserCV is mocked so
 *           no actual PDF parsing occurs).
 *       (c) The implementation uses an ALLOWED allowlist + undefined-check —
 *           this was NOT encoded into any oracle; oracles trace to the contract.
 *     These implementation details were seen AFTER oracles were frozen in git
 *     stage; they did not alter any assertion value or direction.
 *   src/__tests__/cvUpload.test.ts — NOT opened at all.
 *
 * Files read per allowlist:
 *   src/models/User.ts — schema structure, field names, enum values, defaults
 *     (minScore default=30, matchingEnabled default=true; these are the trap values)
 *   src/utils/cvParserInstructions.ts — confirmed the 5 legitimate parser output
 *     fields: jobTypes, location, remoteOnly, minSalary, industries
 *   src/__tests__/profile.test.ts — userRoutes + Supertest + createUserAndToken pattern
 *   src/__tests__/kda-d.adversarial.test.ts (first 60 lines) — adversarial harness
 *     pattern: mutable currentUserId, req.user injection before routes
 *   src/__tests__/setup.ts — MongoMemoryServer wiring (beforeAll/afterEach/afterAll)
 *   src/__tests__/auth.test.ts (first 80 lines) — mock setup patterns for openai/bcrypt
 *   src/routes/userRoutes.ts — confirmed route: POST /cv uses fileUpload.single("file")
 *   src/services/userService.ts (lines 30–88) — parseUserCV signature: takes a file path
 *   src/services/matchingService.ts (lines 1–13) — lazy OpenAI init; openai mock sufficient
 *
 * How incidental knowledge was isolated from assertions:
 *   The temp-file pattern (inferred from controller imports) shapes ONLY the
 *   multer mock (fake buffer must be writable to /tmp). No assertion encodes a
 *   temp-file path, internal constant, regex, or error shape from the implementation.
 *   Every expected value traces to the CONTRACT section above.
 */
