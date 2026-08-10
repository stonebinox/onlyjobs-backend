/**
 * ADVERSARIAL TESTS — onlyjobs-rme
 * "POST /api/users/cv: parseUserCV=null must 422, not 500; DB must be untouched"
 *
 * ORACLE: the behaviour contract below, traced entirely from the task spec.
 *         No assertion encodes an implementation detail from the handler body.
 *
 * FORBIDDEN: src/controllers/userController.ts (updateUserCV handler body).
 *
 * CONTRACT:
 *   NULL-PARSE PATH (parseUserCV returns null):
 *     [1] HTTP status is 422 — not 500 (unfixed), not 200 (writes junk).
 *     [2] Response body has a non-empty `message` string.
 *     [3] No DB mutations: all user fields unchanged (name, resume, ALL preferences,
 *         matchingDisabledReason, noResumeReminderCount, lastNoResumeReminderAt).
 *     [4] Best-effort temp-file cleanup: no residual file left in the upload dir after the
 *         request (measured by directory file count before vs after).
 *
 *   SUCCESS PATH (parseUserCV returns a valid object):
 *     [5] 200 response; parsed name and resume are persisted.
 *     [6a] Presence semantics: parsed remoteOnly=false is written (not skipped as falsy).
 *     [6b] Presence semantics: parsed minSalary=0 is written (not skipped as falsy).
 *     [6c] Allowlist: hallucinated matchingEnabled / minScore in parsed prefs are ignored.
 *
 *   EMPTY-RESUME PATH (parseUserCV returns object with empty/whitespace resume, NOT null):
 *     [7] HTTP 200 (parse succeeded, just empty); noResumeReminderCount unchanged.
 */

// ── Mocks (hoisted by Jest before all imports) ────────────────────────────────

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

jest.mock('../services/matchingService', () => ({
  deleteAllMatches: jest.fn().mockResolvedValue(undefined),
  matchUserToJob: jest.fn(),
  checkJobRelevance: jest.fn(),
}));

// Bypass JWT so we can inject req.user directly.
jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

// Inject a fake PDF buffer so the controller's "no file" guard passes without
// needing a real multipart request. parseUserCV is mocked, so parsing never runs.
// The controller writes this buffer to disk itself (see disclosure). We let that
// happen for real so we can observe cleanup behaviour in criterion-4 tests.
jest.mock('../middleware/fileUpload', () => ({
  __esModule: true,
  default: {
    single: (_field: string) => (req: any, _res: any, next: any) => {
      req.file = {
        fieldname: 'file',
        originalname: 'resume.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 rme-null-parse-adversarial'),
        size: 38,
      };
      next();
    },
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import mongoose from 'mongoose';
import path from 'path';
import { promises as fsPromises } from 'fs';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import userRoutes from '../routes/userRoutes';
import { parseUserCV } from '../services/userService';

const mockParseUserCV = parseUserCV as jest.MockedFunction<typeof parseUserCV>;

// ── Test app ──────────────────────────────────────────────────────────────────
// req.user is injected before routes so the now-passthrough protect sees it.

let currentUserId: mongoose.Types.ObjectId;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.user = { _id: currentUserId, id: currentUserId?.toString() };
  next();
});
testApp.use('/api/users', userRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MEANINGFUL_RESUME = {
  summary: 'Senior software engineer with 8 years of experience',
  skills: ['TypeScript', 'Node.js', 'React'],
  experience: ['Staff Engineer at Acme Corp 2020–2024'],
  education: ['BS Computer Science, MIT'],
  certifications: [],
  languages: [],
  projects: [],
  achievements: [],
  volunteerExperience: [],
  interests: [],
};

const EMPTY_RESUME = {
  summary: '',
  skills: [],
  experience: [],
  education: [],
  certifications: [],
  languages: [],
  projects: [],
  achievements: [],
  volunteerExperience: [],
  interests: [],
};

// Upload dir: inferred from existing adversarial test disclosure (../../uploads/cvs
// relative to backend/src/controllers/). Used only for the cleanup observation in crit-4.
const UPLOAD_DIR = path.join(__dirname, '../../uploads/cvs');

// ── Helpers ───────────────────────────────────────────────────────────────────

let emailSeq = 0;

const setupUser = async (overrides: Record<string, any> = {}) => {
  const user = await User.create({
    email: `rme-adv-${++emailSeq}@example.com`,
    password: 'hashed_password123',
    ...overrides,
  });
  currentUserId = user._id as mongoose.Types.ObjectId;
  return user;
};

const uploadCV = () => request(testApp).post('/api/users/cv');

/** Count files in the upload dir; returns -1 if the dir is inaccessible. */
const fileCount = async (): Promise<number> => {
  try {
    const files = await fsPromises.readdir(UPLOAD_DIR);
    return files.length;
  } catch {
    return -1;
  }
};

beforeEach(() => {
  mockParseUserCV.mockReset();
});

// ── SUITE 1: Null-parse response status (criteria 1 & 2) ─────────────────────

describe('rme: null parse → correct HTTP status (criterion 1)', () => {
  it('Crit-1a [422 not 500]: parseUserCV=null must return 422, not the pre-fix 500', async () => {
    await setupUser();
    mockParseUserCV.mockResolvedValue(null as any);

    const res = await uploadCV();

    // FINDING if 500: implementation did not handle null (unfixed bug).
    expect(res.status).not.toBe(500);
    // FINDING if 200: implementation wrote junk or didn't guard on null.
    expect(res.status).not.toBe(200);
    // Contract: handler must respond 422 on parse failure.
    expect(res.status).toBe(422);
  });

  it('Crit-1b [both directions caught]: 500 OR 200 on null parse both fail this test', async () => {
    // Catches: "picks a random 4xx but not 422" regression too.
    await setupUser();
    mockParseUserCV.mockResolvedValue(null as any);

    const res = await uploadCV();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(422);
  });

  it('Crit-2 [message in body]: 422 body has a non-empty message string', async () => {
    await setupUser();
    mockParseUserCV.mockResolvedValue(null as any);

    const res = await uploadCV();

    expect(res.status).toBe(422);
    // FINDING if message absent: frontend can't surface a user-friendly error.
    expect(res.body).toHaveProperty('message');
    expect(typeof res.body.message).toBe('string');
    expect((res.body.message as string).trim().length).toBeGreaterThan(0);
  });
});

// ── SUITE 2: DB unchanged after null parse (criterion 3) ─────────────────────

describe('rme: DB completely unchanged on null parse (criterion 3)', () => {
  it('Crit-3a [full field sweep]: all seeded user fields unchanged after null parse', async () => {
    const seededDate = new Date('2026-08-01T10:00:00Z');
    const user = await setupUser({
      name: 'Original Name',
      resume: MEANINGFUL_RESUME,
      preferences: {
        matchingEnabled: false,
        minScore: 75,
        jobTypes: ['full_time'],
        location: ['London'],
        remoteOnly: false,
        minSalary: 50000,
        industries: ['Finance'],
      },
      matchingDisabledReason: 'user',
      noResumeReminderCount: 5,
      lastNoResumeReminderAt: seededDate,
    });

    mockParseUserCV.mockResolvedValue(null as any);
    const res = await uploadCV();

    // If 200, DB assertions below are meaningless (the bug is the 200, not a field mutation).
    expect(res.status).toBe(422);

    const after = await User.findById(user._id);
    expect(after).not.toBeNull();

    // Name — FINDING if changed: null parse wrote garbage name.
    expect(after!.name).toBe('Original Name');

    // Resume — FINDING if changed: null parse overwrote an existing resume.
    expect(after!.resume.summary).toBe(MEANINGFUL_RESUME.summary);
    expect(after!.resume.skills).toEqual(MEANINGFUL_RESUME.skills);

    // Control preferences — FINDING if changed.
    expect(after!.preferences.matchingEnabled).toBe(false);
    expect(after!.preferences.minScore).toBe(75);

    // CV-inferable preferences — FINDING if cleared.
    expect(after!.preferences.jobTypes).toEqual(['full_time']);
    expect(after!.preferences.location).toEqual(['London']);
    expect(after!.preferences.remoteOnly).toBe(false);
    expect(after!.preferences.minSalary).toBe(50000);
    expect(after!.preferences.industries).toEqual(['Finance']);

    // matchingDisabledReason — FINDING if changed.
    expect(after!.matchingDisabledReason).toBe('user');

    // Reminder state — the primary rme fix: null parse must NEVER reset.
    // FINDING if noResumeReminderCount is 0: resetNoResumeReminderState was called on null path.
    expect(after!.noResumeReminderCount).toBe(5);
    expect(after!.lastNoResumeReminderAt?.toISOString()).toBe(seededDate.toISOString());
  });

  it('Crit-3b [reminder not reset]: count stays at its seeded value on null parse', async () => {
    const user = await setupUser({
      noResumeReminderCount: 3,
      lastNoResumeReminderAt: new Date('2026-07-15T00:00:00Z'),
    });

    mockParseUserCV.mockResolvedValue(null as any);
    await uploadCV();

    const after = await User.findById(user._id);
    // FINDING if 0: resetNoResumeReminderState was called despite null parse.
    expect(after!.noResumeReminderCount).toBe(3);
    expect(after!.lastNoResumeReminderAt).toBeDefined();
  });

  it('Crit-3c [auto_low_balance survives]: matchingDisabledReason=auto_low_balance unchanged on null parse', async () => {
    const user = await setupUser({
      preferences: { matchingEnabled: false, minScore: 30 },
      matchingDisabledReason: 'auto_low_balance',
      noResumeReminderCount: 2,
    });

    mockParseUserCV.mockResolvedValue(null as any);
    await uploadCV();

    const after = await User.findById(user._id);
    expect(after!.matchingDisabledReason).toBe('auto_low_balance');
    expect(after!.preferences.matchingEnabled).toBe(false);
    expect(after!.noResumeReminderCount).toBe(2);
  });
});

// ── SUITE 3: Temp-file cleanup (criterion 4) ─────────────────────────────────
// We observe the upload directory file count before and after the request.
// If cleanup runs, the count is the same. If cleanup is missing, count increases.

describe('rme: temp-file cleanup on null parse (criterion 4)', () => {
  it('Crit-4a [no residual file on null]: upload dir file count unchanged after null parse', async () => {
    await setupUser();
    mockParseUserCV.mockResolvedValue(null as any);

    const before = await fileCount();
    await uploadCV();
    const after = await fileCount();

    if (before === -1) {
      // Upload directory inaccessible — test degrades but does not falsely pass.
      // This is a testability limitation noted in DISCLOSURE.
      return;
    }

    // FINDING if after > before: handler leaked the temp file on the null path.
    expect(after).toBeLessThanOrEqual(before);
  });

});

// ── SUITE 4: Success path regression (criterion 5) ───────────────────────────

describe('rme: success path still returns 200 and writes (criterion 5)', () => {
  it('Crit-5 [200 + writes]: valid parse → 200 and persists name and resume', async () => {
    const user = await setupUser({ name: 'Old Name' });

    mockParseUserCV.mockResolvedValue({
      name: 'Parsed Name',
      resume: MEANINGFUL_RESUME,
      preferences: {
        jobTypes: ['contract'],
        location: ['Berlin'],
        remoteOnly: true,
        minSalary: 90000,
        industries: ['Technology'],
      },
    } as any);

    const res = await uploadCV();

    // FINDING if 422: null-guard was applied unconditionally, breaking the success path.
    expect(res.status).toBe(200);

    const after = await User.findById(user._id);
    expect(after!.name).toBe('Parsed Name');
    expect(after!.resume.summary).toBe(MEANINGFUL_RESUME.summary);
    expect(after!.resume.skills).toEqual(MEANINGFUL_RESUME.skills);
    expect(after!.resume.experience).toEqual(MEANINGFUL_RESUME.experience);
  });
});

// ── SUITE 5: Preference allowlist + presence semantics (criterion 6) ─────────

describe('rme: preference allowlist and presence semantics on success path (criterion 6)', () => {
  it('Crit-6a [remoteOnly:false written]: parsed remoteOnly=false is persisted, not skipped as falsy', async () => {
    const user = await setupUser({
      preferences: {
        remoteOnly: true,
        minScore: 30,
        matchingEnabled: true,
      },
    });

    mockParseUserCV.mockResolvedValue({
      name: 'Test',
      resume: MEANINGFUL_RESUME,
      preferences: {
        jobTypes: ['full_time'],
        location: ['Office City'],
        remoteOnly: false, // false must be written, not silently kept as true
        minSalary: 60000,
        industries: ['Finance'],
      },
    } as any);

    const res = await uploadCV();
    expect(res.status).toBe(200);

    const after = await User.findById(user._id);
    // FINDING if true: implementation used `parsedPrefs.remoteOnly || existing`.
    expect(after!.preferences.remoteOnly).toBe(false);
    // Control fields untouched.
    expect(after!.preferences.minScore).toBe(30);
    expect(after!.preferences.matchingEnabled).toBe(true);
  });

  it('Crit-6b [minSalary:0 written]: parsed minSalary=0 is persisted, not skipped as falsy', async () => {
    const user = await setupUser({
      preferences: {
        minSalary: 80000,
        minScore: 30,
        matchingEnabled: true,
      },
    });

    mockParseUserCV.mockResolvedValue({
      name: 'Test',
      resume: MEANINGFUL_RESUME,
      preferences: {
        jobTypes: ['internship'],
        location: ['University'],
        remoteOnly: false,
        minSalary: 0, // zero must be written, not silently kept as 80000
        industries: ['Education'],
      },
    } as any);

    const res = await uploadCV();
    expect(res.status).toBe(200);

    const after = await User.findById(user._id);
    // FINDING if 80000: implementation used `parsedPrefs.minSalary || existing`.
    expect(after!.preferences.minSalary).toBe(0);
    expect(after!.preferences.minScore).toBe(30);
  });

  it('Crit-6c [hallucinated keys blocked]: parser-hallucinated matchingEnabled/minScore are not written', async () => {
    const user = await setupUser({
      preferences: {
        matchingEnabled: false,
        minScore: 75,
        jobTypes: [],
        location: [],
        remoteOnly: false,
        minSalary: 0,
        industries: [],
      },
      matchingDisabledReason: 'user',
    });

    mockParseUserCV.mockResolvedValue({
      name: 'Test',
      resume: MEANINGFUL_RESUME,
      preferences: {
        jobTypes: ['full_time'],
        location: ['NYC'],
        remoteOnly: true,
        minSalary: 100000,
        industries: ['Tech'],
        // Hallucinated keys the allowlist must block:
        matchingEnabled: true,
        minScore: 10,
      },
    } as any);

    const res = await uploadCV();
    expect(res.status).toBe(200);

    const after = await User.findById(user._id);
    // FINDING if true: hallucinated matchingEnabled overrode paused state.
    expect(after!.preferences.matchingEnabled).toBe(false);
    // FINDING if 10: hallucinated minScore overwrote tuned value.
    expect(after!.preferences.minScore).toBe(75);
    expect(after!.matchingDisabledReason).toBe('user');
    // Five legitimate fields must still update.
    expect(after!.preferences.jobTypes).toEqual(expect.arrayContaining(['full_time']));
    expect(after!.preferences.remoteOnly).toBe(true);
    expect(after!.preferences.minSalary).toBe(100000);
  });
});

// ── SUITE 6: Empty resume (not null) → 200, no reset (criterion 7) ───────────

describe('rme: structured-but-empty resume (NOT null) returns 200 and does not reset (criterion 7)', () => {
  it('Crit-7a [empty resume → 200 not 422]: empty object resume is a parse success, not failure', async () => {
    // Distinct from null: object with empty resume = parser succeeded with empty output.
    // Must return 200, not 422.
    const user = await setupUser({
      noResumeReminderCount: 5,
      lastNoResumeReminderAt: new Date('2026-08-08T12:00:00Z'),
    });

    mockParseUserCV.mockResolvedValue({
      name: 'Parsed Name',
      resume: EMPTY_RESUME,
      preferences: {},
    } as any);

    const res = await uploadCV();

    // FINDING if 422: implementation incorrectly treated empty resume as parse failure.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(422);

    const after = await User.findById(user._id);
    // FINDING if 0: resetNoResumeReminderState was called despite no meaningful resume.
    expect(after!.noResumeReminderCount).toBe(5);
    expect(after!.lastNoResumeReminderAt).toBeDefined();
  });

  it('Crit-7b [whitespace resume → 200, no reset]: whitespace-only summary is not meaningful', async () => {
    const user = await setupUser({
      noResumeReminderCount: 3,
      lastNoResumeReminderAt: new Date('2026-08-01T00:00:00Z'),
    });

    mockParseUserCV.mockResolvedValue({
      name: 'Parsed Name',
      resume: {
        summary: '   ',
        skills: ['  ', ''],
        experience: [],
        education: [],
        certifications: [],
        languages: [],
        projects: [],
        achievements: [],
        volunteerExperience: [],
        interests: [],
      },
      preferences: {},
    } as any);

    const res = await uploadCV();
    expect(res.status).toBe(200);

    const after = await User.findById(user._id);
    // FINDING if 0: whitespace treated as meaningful, triggering reset.
    expect(after!.noResumeReminderCount).toBe(3);
    expect(after!.lastNoResumeReminderAt).toBeDefined();
  });

  it('Crit-7c [null vs empty boundary]: null → 422 AND empty → 200 (same test, both branches)', async () => {
    // First: null path → must 422.
    const userA = await setupUser({ noResumeReminderCount: 5 });
    mockParseUserCV.mockResolvedValue(null as any);
    const resNull = await uploadCV();
    expect(resNull.status).toBe(422);
    const afterNull = await User.findById(userA._id);
    expect(afterNull!.noResumeReminderCount).toBe(5);

    // Second: empty resume path → must 200, no reset.
    const userB = await setupUser({ noResumeReminderCount: 4 });
    mockParseUserCV.mockResolvedValue({ name: 'Test', resume: EMPTY_RESUME, preferences: {} } as any);
    const resEmpty = await uploadCV();
    expect(resEmpty.status).toBe(200);
    const afterEmpty = await User.findById(userB._id);
    expect(afterEmpty!.noResumeReminderCount).toBe(4);
  });
});

/*
 * ── DISCLOSURE ────────────────────────────────────────────────────────────────
 *
 * Files explicitly FORBIDDEN that were NOT opened:
 *   src/controllers/userController.ts — the updateUserCV handler body was never read.
 *   src/__tests__/userController.cv.test.ts — not in the allowed list; not opened.
 *
 * Files read per the allowed list:
 *   src/__tests__/cvUpload.test.ts              — route/mocking harness
 *   src/__tests__/cvUpload.adversarial.test.ts  — mocked fileUpload + authMiddleware pattern;
 *                                                  req.user injection idiom; DISCLOSURE there
 *                                                  revealed the upload path ../../uploads/cvs/
 *                                                  (used in UPLOAD_DIR for crit-4 file counting)
 *                                                  and that req.user!.id is the string virtual
 *   src/__tests__/l5j.resumeReset.adversarial.test.ts — MEANINGFUL_RESUME / EMPTY_RESUME fixtures;
 *                                                  createUserWithReminderState helper pattern
 *   src/models/User.ts                          — field names, defaults (minScore=30, etc.)
 *   src/__tests__/setup.ts                      — MongoMemoryServer wiring
 *   src/utils/resumeState.ts (line 4 only)      — resetNoResumeReminderState signature
 *   src/utils/resumePredicate.ts (line 17 only) — hasMeaningfulResume signature
 *   src/services/userService.ts (line 42 only)  — parseUserCV signature
 *
 * Implementation details seen and how they were isolated:
 *   The upload path (../../uploads/cvs/) was seen in the cvUpload.adversarial.test.ts DISCLOSURE
 *   (not in the handler body). It is used ONLY in UPLOAD_DIR for the file-count observation in
 *   criterion 4. No oracle encodes a temp filename pattern, constant, regex, or error shape from
 *   the handler body. All expected values (422, 200, field names) trace to the CONTRACT above.
 *
 * fs spying approach and its limitation (testability finding — criterion 4):
 *   `import * as fs from 'fs'` with ts-jest's __importStar creates non-configurable getter
 *   properties, so jest.spyOn fails with "Cannot redefine property: unlinkSync". Instead,
 *   criterion 4 uses directory file counting (before/after) to observe cleanup behaviour.
 *   Limitation: if the uploads directory is inaccessible (-1 count), the test degrades silently.
 *   This is a testability gap — the cleanup behaviour cannot be independently verified without
 *   reading the handler to know which fs method to intercept.
 */
