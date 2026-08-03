// REGRESSION: POST /api/users/cv must not wipe matchingEnabled, minScore, or
// matchingDisabledReason — only the five CV-inferable preference fields may change.

process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({}),
}));

jest.mock('../services/emailService', () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(true),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(true),
}));

// Mock parseUserCV so we control what the parser returns without hitting OpenAI.
const mockParseUserCV = jest.fn();
jest.mock('../services/userService', () => {
  const original = jest.requireActual('../services/userService');
  return {
    ...original,
    parseUserCV: (...args: unknown[]) => mockParseUserCV(...args),
  };
});

import request from 'supertest';
import express from 'express';
import userRoutes from '../routes/userRoutes';
import User from '../models/User';
import { generateToken } from '../utils/generateToken';

const testApp = express();
testApp.use(express.json());
testApp.use('/api/users', userRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

describe('POST /api/users/cv — preference preservation (REGRESSION: onlyjobs-edh)', () => {
  it('preserves matchingEnabled=false, minScore, and matchingDisabledReason after CV upload', async () => {
    // Create a user who deliberately paused matching and tuned minScore.
    const user = await User.create({
      email: 'cv-regression@example.com',
      password: 'hashed_irrelevant',
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
    });
    const token = generateToken(user.id);

    // Simulate the CV parser returning the five inferable fields (no matchingEnabled, no minScore).
    mockParseUserCV.mockResolvedValueOnce({
      name: 'Alice Smith',
      resume: { skills: ['TypeScript', 'Node.js'], summary: 'Senior engineer', experience: [], education: [], certifications: [], languages: [], projects: [], achievements: [], volunteerExperience: [], interests: [] },
      preferences: {
        jobTypes: ['full_time', 'contract'],
        location: ['Berlin', 'Remote'],
        remoteOnly: true,
        minSalary: 80000,
        industries: ['Technology', 'Fintech'],
      },
    });

    // A minimal valid PDF buffer (1-byte placeholder) — multer is in memory mode, so the
    // controller receives req.file.buffer.  The mimetype check runs before parsing, so we
    // attach a buffer with the PDF mime type.  parseUserCV is mocked above.
    const pdfBuffer = Buffer.from('%PDF-1.4 placeholder');

    const res = await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pdfBuffer, { filename: 'resume.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated).not.toBeNull();

    // --- The control fields must survive unchanged ---
    expect(updated!.preferences.matchingEnabled).toBe(false);
    expect(updated!.preferences.minScore).toBe(75);
    expect(updated!.matchingDisabledReason).toBe('user');

    // --- The five inferable fields must be updated ---
    expect(updated!.preferences.jobTypes).toEqual(['full_time', 'contract']);
    expect(updated!.preferences.location).toEqual(['Berlin', 'Remote']);
    expect(updated!.preferences.remoteOnly).toBe(true);
    expect(updated!.preferences.minSalary).toBe(80000);
    expect(updated!.preferences.industries).toEqual(['Technology', 'Fintech']);

    // --- Name and resume must be updated ---
    expect(updated!.name).toBe('Alice Smith');
    expect(updated!.resume.summary).toBe('Senior engineer');
    expect(updated!.resume.skills).toEqual(['TypeScript', 'Node.js']);
  });

  it('does not write matchingEnabled or minScore even if the parser hallucinated them', async () => {
    const user = await User.create({
      email: 'cv-hallucination@example.com',
      password: 'hashed_irrelevant',
      preferences: {
        matchingEnabled: false,
        minScore: 60,
        jobTypes: [],
        location: [],
        remoteOnly: false,
        minSalary: 0,
        industries: [],
      },
      matchingDisabledReason: 'auto_low_balance',
    });
    const token = generateToken(user.id);

    // Parser hallucinated matchingEnabled and minScore — the allowlist must block them.
    mockParseUserCV.mockResolvedValueOnce({
      name: 'Bob',
      resume: { skills: ['Java'], summary: 'Developer', experience: [], education: [], certifications: [], languages: [], projects: [], achievements: [], volunteerExperience: [], interests: [] },
      preferences: {
        jobTypes: ['part_time'],
        location: ['Paris'],
        remoteOnly: false,
        minSalary: 30000,
        industries: ['Retail'],
        matchingEnabled: true,   // hallucinated — must be IGNORED
        minScore: 10,            // hallucinated — must be IGNORED
      },
    });

    const pdfBuffer = Buffer.from('%PDF-1.4 placeholder');

    const res = await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pdfBuffer, { filename: 'resume.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.preferences.matchingEnabled).toBe(false);
    expect(updated!.preferences.minScore).toBe(60);
    expect(updated!.matchingDisabledReason).toBe('auto_low_balance');
  });
});
