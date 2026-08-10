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

// parseUserCV is mocked so we control what "parsed resume" comes back without real PDF/AI calls
const parseUserCVMock = jest.fn();
jest.mock('../services/userService', () => ({
  findUserByEmail: jest.fn(),
  getUserNameById: jest.fn(),
  parseUserCV: (...args: unknown[]) => parseUserCVMock(...args),
  getAIQuestion: jest.fn().mockResolvedValue(null),
  answerQuestion: jest.fn().mockResolvedValue(null),
  parseAudioAnswer: jest.fn().mockResolvedValue(null),
  getUserQnA: jest.fn().mockResolvedValue([]),
  skipQuestion: jest.fn().mockResolvedValue(null),
  getAnswerForQuestion: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/matchingService', () => ({
  deleteAllMatches: jest.fn().mockResolvedValue(undefined),
  matchUserToJob: jest.fn(),
  checkJobRelevance: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import userRoutes from '../routes/userRoutes';
import User from '../models/User';
import { generateToken } from '../utils/generateToken';
import { resetNoResumeReminderState } from '../utils/resumeState';

const testApp = express();
testApp.use(express.json());
testApp.use('/api/users', userRoutes);
testApp.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (res.statusCode !== 200 ? res.statusCode : 500);
  res.status(status).json({ error: err.message });
});

// Meaningful resume — hasMeaningfulResume returns true
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

// Empty resume — hasMeaningfulResume returns false
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

// Whitespace-only resume — hasMeaningfulResume returns false (whitespace ≠ meaningful)
const WHITESPACE_RESUME = {
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
};

async function createUserWithReminderState(overrides: Record<string, unknown> = {}) {
  const user = await User.create({
    email: 'reset-test@example.com',
    password: 'hashed_password123',
    noResumeReminderCount: 5,
    lastNoResumeReminderAt: new Date('2026-08-08T12:00:00Z'),
    isVerified: true,
    walletBalance: 1.0,
    ...overrides,
  });
  const token = generateToken(user.id);
  return { user, token };
}

// ─── SUITE 1: resetNoResumeReminderState directly ─────────────────────────
// Tests the utility function itself — proves the state change contract.
// If these fail, criteria 8 and 9 are broken at the function level.

describe("l5j: resetNoResumeReminderState direct contract (criteria 8/9 foundation)", () => {
  test("sets noResumeReminderCount to 0 and unsets lastNoResumeReminderAt", async () => {
    const user = await User.create({
      email: 'direct-reset@example.com',
      password: 'hashed_pw',
      noResumeReminderCount: 5,
      lastNoResumeReminderAt: new Date('2026-08-08T12:00:00Z'),
      isVerified: true,
    });

    await resetNoResumeReminderState(user._id);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(0);
    expect(updated!.lastNoResumeReminderAt).toBeUndefined();
  });

  test("reset when count is already 0 is idempotent (does not go negative)", async () => {
    const user = await User.create({
      email: 'idempotent-reset@example.com',
      password: 'hashed_pw',
      noResumeReminderCount: 0,
      lastNoResumeReminderAt: undefined,
      isVerified: true,
    });

    await resetNoResumeReminderState(user._id);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(0);
    expect(updated!.lastNoResumeReminderAt).toBeUndefined();
  });

  test("reset targets the correct userId (other users unaffected)", async () => {
    const userA = await User.create({
      email: 'userA@example.com',
      password: 'hashed_pw',
      noResumeReminderCount: 3,
      lastNoResumeReminderAt: new Date('2026-08-07T00:00:00Z'),
      isVerified: true,
    });
    const userB = await User.create({
      email: 'userB@example.com',
      password: 'hashed_pw',
      noResumeReminderCount: 4,
      lastNoResumeReminderAt: new Date('2026-08-07T00:00:00Z'),
      isVerified: true,
    });

    await resetNoResumeReminderState(userA._id);

    const afterA = await User.findById(userA._id);
    const afterB = await User.findById(userB._id);

    expect(afterA!.noResumeReminderCount).toBe(0);
    expect(afterA!.lastNoResumeReminderAt).toBeUndefined();

    // userB must NOT be affected
    expect(afterB!.noResumeReminderCount).toBe(4);
    expect(afterB!.lastNoResumeReminderAt).toBeDefined();
  });
});

// ─── SUITE 2: CV upload — meaningful resume resets state (criterion 8) ─────

describe("l5j: CV upload with meaningful resume resets reminder state (criterion 8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    parseUserCVMock.mockResolvedValue({
      name: 'Test User',
      resume: MEANINGFUL_RESUME,
      preferences: {},
    });
  });

  test("seeded count=5 + date → after upload with meaningful resume: count=0, date unset", async () => {
    const { user, token } = await createUserWithReminderState();

    const dummyPDF = Buffer.from('%PDF-1.4 minimal test');
    const res = await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', dummyPDF, { filename: 'resume.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(0);
    expect(updated!.lastNoResumeReminderAt).toBeUndefined();
  });

  test("count=3 → after upload with meaningful resume: count=0", async () => {
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 3 });

    const dummyPDF = Buffer.from('%PDF-1.4 minimal test');
    await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', dummyPDF, { filename: 'resume.pdf', contentType: 'application/pdf' });

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(0);
    expect(updated!.lastNoResumeReminderAt).toBeUndefined();
  });
});

// ─── SUITE 3: CV upload — empty/whitespace resume does NOT reset (criterion 10) ─

describe("l5j: CV upload with empty/whitespace resume does NOT reset (criterion 10)", () => {
  test("parseUserCV returns empty resume: count stays unchanged", async () => {
    parseUserCVMock.mockResolvedValue({
      name: 'Test User',
      resume: EMPTY_RESUME,
      preferences: {},
    });
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 5 });

    const dummyPDF = Buffer.from('%PDF-1.4 minimal test');
    const res = await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', dummyPDF, { filename: 'empty.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(5);
    expect(updated!.lastNoResumeReminderAt).toBeDefined();
  });

  test("parseUserCV returns whitespace-only resume: count stays unchanged", async () => {
    parseUserCVMock.mockResolvedValue({
      name: 'Test User',
      resume: WHITESPACE_RESUME,
      preferences: {},
    });
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 3 });

    const dummyPDF = Buffer.from('%PDF-1.4 minimal test');
    const res = await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', dummyPDF, { filename: 'whitespace.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(3);
    expect(updated!.lastNoResumeReminderAt).toBeDefined();
  });

  test("parseUserCV returns null (parse failure): status is 422 AND count stays unchanged", async () => {
    parseUserCVMock.mockResolvedValue(null);
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 2 });

    const dummyPDF = Buffer.from('%PDF-1.4 minimal test');
    // Contract (rme fix): null parse → exactly 422, and count must not reset.
    const res = await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', dummyPDF, { filename: 'bad.pdf', contentType: 'application/pdf' });

    // FINDING if not 422: handler returned 500 (unfixed) or 200 (writes-on-null).
    expect(res.status).toBe(422);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(2);
  });
});

// ─── SUITE 4: Profile edit — meaningful resume resets state (criterion 9) ──

describe("l5j: profile edit with meaningful resume resets reminder state (criterion 9)", () => {
  test("seeded count=5 → PUT /profile with meaningful summary: count=0, date unset", async () => {
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 5 });

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        resume: {
          summary: 'Senior engineer with 10 years of experience in distributed systems',
          skills: ['Go', 'Kubernetes', 'Rust'],
          experience: ['Principal SWE at TechCorp 2021–2025'],
          education: ['MS Computer Engineering, Stanford'],
        },
      });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(0);
    expect(updated!.lastNoResumeReminderAt).toBeUndefined();
  });

  test("resume with only skills (no summary): count=0 (skills alone make it meaningful)", async () => {
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 3 });

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        resume: {
          summary: '',
          skills: ['Python', 'Machine Learning'],
          experience: [],
          education: [],
        },
      });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(0);
    expect(updated!.lastNoResumeReminderAt).toBeUndefined();
  });
});

// ─── SUITE 5: Profile edit — empty/whitespace resume does NOT reset (criterion 10) ─

describe("l5j: profile edit with empty resume does NOT reset (criterion 10)", () => {
  test("PUT /profile with empty resume fields: count stays at seeded value", async () => {
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 5 });

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        resume: {
          summary: '',
          skills: [],
          experience: [],
          education: [],
        },
      });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(5);
    expect(updated!.lastNoResumeReminderAt).toBeDefined();
  });

  test("PUT /profile with whitespace-only summary and empty arrays: count stays unchanged", async () => {
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 4 });

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        resume: {
          summary: '    ',
          skills: [],
          experience: [],
          education: [],
        },
      });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(4);
    expect(updated!.lastNoResumeReminderAt).toBeDefined();
  });
});

// ─── SUITE 6: Profile edit with non-resume fields does NOT reset (criterion 11) ─

describe("l5j: profile edit with non-resume fields does NOT reset (criterion 11)", () => {
  test("PUT /profile updating only name: count stays unchanged", async () => {
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 5 });

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name Only' });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(5);
    expect(updated!.lastNoResumeReminderAt).toBeDefined();
  });

  test("PUT /profile updating only phone: count stays unchanged", async () => {
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 3 });

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+1-555-0100' });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(3);
    expect(updated!.lastNoResumeReminderAt).toBeDefined();
  });

  test("PUT /profile updating only currentLocation: count stays unchanged", async () => {
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 2 });

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentLocation: 'Berlin, Germany' });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(2);
    expect(updated!.lastNoResumeReminderAt).toBeDefined();
  });

  test("ADVERSARIAL: meaningful resume in body alongside non-resume fields DOES reset (boundary correctness)", async () => {
    // If the profile update includes a meaningful resume AND other fields, the reset must fire.
    // This tests that the guard doesn't fire only for pure-resume updates.
    const { user, token } = await createUserWithReminderState({ noResumeReminderCount: 5 });

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'New Name',
        currentLocation: 'Tokyo, Japan',
        resume: {
          summary: 'Full stack engineer with 6 years experience',
          skills: ['React', 'GraphQL'],
          experience: [],
          education: [],
        },
      });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.noResumeReminderCount).toBe(0);
    expect(updated!.lastNoResumeReminderAt).toBeUndefined();
  });
});

// ─── SUITE 7: Reset must NOT fire when save is never reached (ordering bug) ──
// Regression test for the pre-fix ordering bug: reset fired at the resume block
// BEFORE user.save(), so a later validation error aborted persistence but the
// reminder state was already wiped. The fix moves the reset to AFTER save().
// This test FAILS against the pre-fix code and passes after.

describe("l5j: reset does NOT fire when save is aborted by a post-resume validation error (ordering guard)", () => {
  test("meaningful resume + invalid socialLinks key: request 400s, count stays at 5, date unchanged", async () => {
    const seededDate = new Date('2026-08-08T12:00:00Z');
    const { user, token } = await createUserWithReminderState({
      noResumeReminderCount: 5,
      lastNoResumeReminderAt: seededDate,
    });

    // socialLinks key 'invalidkey' is not in the allowed list, so the handler throws
    // AFTER the resume block (where the old code fired the reset) but BEFORE user.save().
    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        resume: {
          summary: 'Senior engineer with 10 years of experience building distributed systems',
          skills: ['Go', 'Kubernetes'],
          experience: ['Principal SWE at TechCorp 2021–2025'],
          education: ['MS CS, Stanford'],
        },
        socialLinks: {
          invalidkey: 'https://example.com',
        },
      });

    // The invalid socialLinks key must cause a 4xx rejection
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // No save happened — reminder state must be exactly as seeded
    const after = await User.findById(user._id);
    expect(after!.noResumeReminderCount).toBe(5);
    expect(after!.lastNoResumeReminderAt?.toISOString()).toBe(seededDate.toISOString());
  });
});
