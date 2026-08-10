process.env.JWT_SECRET = 'test-jwt-secret';

// Mock OpenAI before any imports to prevent module-level instantiation errors
jest.mock('openai', () => ({ __esModule: true, default: jest.fn().mockReturnValue({}) }));

jest.mock('../services/emailService', () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(true),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(true),
}));

// Control the parser without hitting OpenAI
const mockParseUserCV = jest.fn();
jest.mock('../services/userService', () => {
  const original = jest.requireActual('../services/userService');
  return { ...original, parseUserCV: (...args: unknown[]) => mockParseUserCV(...args) };
});

import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs';
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

// Same resolution path the controller uses: backend/uploads/cvs
const uploadsDir = path.join(__dirname, '../controllers/../../uploads/cvs');

function countUserFiles(userId: string): number {
  if (!fs.existsSync(uploadsDir)) return 0;
  return fs.readdirSync(uploadsDir).filter(f => f.startsWith(`${userId}-`)).length;
}

// A valid ParsedCV that satisfies the contract (shape from requirement)
const validParsedCV = {
  name: 'Test User',
  resume: {
    skills: ['TypeScript'],
    summary: 'A developer',
    experience: [],
    education: [],
    certifications: [],
    languages: [],
    projects: [],
    achievements: [],
    volunteerExperience: [],
    interests: [],
  },
  preferences: {
    jobTypes: ['full_time'],
    location: ['Remote'],
    remoteOnly: true,
    minSalary: 80000,
    industries: ['Tech'],
  },
};

// Preferences that are NOT touched by CV upload (requirement invariant)
const PROTECTED_PREFS = {
  minScore: 42,
  matchingEnabled: false,
};

let _counter = 0;

describe('le8 — CV upload temp file cleanup (adversarial)', () => {
  let userId: string;
  let token: string;

  beforeEach(async () => {
    _counter += 1;
    const user = await User.create({
      email: `le8-adv-${_counter}@example.com`,
      password: 'hashed_irrelevant',
      preferences: {
        jobTypes: ['contract'],
        location: ['London'],
        remoteOnly: false,
        minSalary: 50000,
        industries: ['Finance'],
        minScore: PROTECTED_PREFS.minScore,
        matchingEnabled: PROTECTED_PREFS.matchingEnabled,
      },
      matchingDisabledReason: 'user',
    });
    userId = user.id;
    token = generateToken(user.id);
    mockParseUserCV.mockReset();
    // Ensure the uploads dir exists so countUserFiles never throws
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
  });

  function uploadFile() {
    return request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 fake content for testing'), {
        filename: 'test.pdf',
        contentType: 'application/pdf',
      });
  }

  // ---------------------------------------------------------------------------
  // Path (a): parseUserCV resolves a valid parsed object → 200
  // ---------------------------------------------------------------------------
  describe('path (a): parseUserCV resolves valid CV', () => {
    it('responds 200 with success:true and the exact contract message', async () => {
      mockParseUserCV.mockResolvedValue(validParsedCV);
      const res = await uploadFile();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('CV uploaded successfully');
    });

    it('removes the temp file after successful parse', async () => {
      mockParseUserCV.mockResolvedValue(validParsedCV);
      await uploadFile();
      expect(countUserFiles(userId)).toBe(0);
    });

    it('does NOT change preferences.matchingEnabled on success', async () => {
      mockParseUserCV.mockResolvedValue(validParsedCV);
      await uploadFile();
      const updated = await User.findById(userId);
      expect(updated!.preferences.matchingEnabled).toBe(PROTECTED_PREFS.matchingEnabled);
    });

    it('does NOT change preferences.minScore on success', async () => {
      mockParseUserCV.mockResolvedValue(validParsedCV);
      await uploadFile();
      const updated = await User.findById(userId);
      expect(updated!.preferences.minScore).toBe(PROTECTED_PREFS.minScore);
    });

    it('does NOT change matchingDisabledReason on success', async () => {
      mockParseUserCV.mockResolvedValue(validParsedCV);
      await uploadFile();
      const updated = await User.findById(userId);
      expect(updated!.matchingDisabledReason).toBe('user');
    });
  });

  // ---------------------------------------------------------------------------
  // Path (b): parseUserCV resolves null → 422 with exact contract message
  // ---------------------------------------------------------------------------
  describe('path (b): parseUserCV resolves null', () => {
    it('responds 422 with success:false and the exact contract message', async () => {
      mockParseUserCV.mockResolvedValue(null);
      const res = await uploadFile();
      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      // This message is part of the requirement — assert exactly
      expect(res.body.message).toBe(
        "We couldn't read that CV. Please try another PDF or DOCX file."
      );
    });

    it('removes the temp file when parse returns null', async () => {
      mockParseUserCV.mockResolvedValue(null);
      await uploadFile();
      expect(countUserFiles(userId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Path (c): parseUserCV rejects / throws — the adversarial path
  // Naive fixes only clean up on success/null and skip this branch entirely.
  // ---------------------------------------------------------------------------
  describe('path (c): parseUserCV throws — CRITICAL adversarial path', () => {
    it('responds non-200 when parseUserCV throws an Error', async () => {
      mockParseUserCV.mockRejectedValue(new Error('OpenAI rate limit'));
      const res = await uploadFile();
      expect(res.status).not.toBe(200);
    });

    it('removes the temp file even when parseUserCV throws an Error', async () => {
      mockParseUserCV.mockRejectedValue(new Error('OpenAI exploded'));
      await uploadFile();
      // A naive implementation that only cleans up inside a then() block will leave this file.
      expect(countUserFiles(userId)).toBe(0);
    });

    it('removes the temp file when parseUserCV rejects with a non-Error value', async () => {
      // Some code throws strings — cover that edge case too
      mockParseUserCV.mockRejectedValue('unexpected string throw');
      await uploadFile();
      expect(countUserFiles(userId)).toBe(0);
    });

    it('removes the temp file when parseUserCV rejects with undefined', async () => {
      mockParseUserCV.mockRejectedValue(undefined);
      await uploadFile();
      expect(countUserFiles(userId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Path (d): post-parse DB failure — file must still be cleaned up
  // ---------------------------------------------------------------------------
  describe('path (d): post-parse DB failure', () => {
    it('removes temp file when findByIdAndUpdate returns null (user not found in DB)', async () => {
      // Parse succeeds; DB update finds no matching document (user gone between auth and update)
      mockParseUserCV.mockResolvedValue(validParsedCV);
      const spy = jest.spyOn(User, 'findByIdAndUpdate').mockResolvedValueOnce(null);
      try {
        const res = await uploadFile();
        expect(countUserFiles(userId)).toBe(0);
        // Requirement says this path responds non-200
        expect(res.status).not.toBe(200);
      } finally {
        spy.mockRestore();
      }
    });

    it('removes temp file when findByIdAndUpdate throws a DB error', async () => {
      mockParseUserCV.mockResolvedValue(validParsedCV);
      const spy = jest
        .spyOn(User, 'findByIdAndUpdate')
        .mockRejectedValueOnce(new Error('MongoNetworkError'));
      try {
        const res = await uploadFile();
        expect(countUserFiles(userId)).toBe(0);
        expect(res.status).not.toBe(200);
      } finally {
        spy.mockRestore();
      }
    });

    it('removes temp file when user is deleted between auth check and DB update', async () => {
      // Simulate mid-request deletion: after parse succeeds, the DB update finds nothing
      mockParseUserCV.mockImplementation(async () => {
        // User is deleted while request is in-flight, after the auth middleware has already passed
        await User.deleteOne({ _id: userId });
        return validParsedCV;
      });
      const res = await uploadFile();
      // Primary assertion: no leaked file
      expect(countUserFiles(userId)).toBe(0);
      // Secondary: requirement says non-200 when update matches nothing
      expect(res.status).not.toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Accumulation guard: files must not pile up across sequential requests
  // ---------------------------------------------------------------------------
  describe('accumulation guard', () => {
    it('leaves zero files after three sequential uploads: success → null → throw', async () => {
      mockParseUserCV.mockResolvedValueOnce(validParsedCV);
      await uploadFile();
      expect(countUserFiles(userId)).toBe(0);

      mockParseUserCV.mockResolvedValueOnce(null);
      await uploadFile();
      expect(countUserFiles(userId)).toBe(0);

      mockParseUserCV.mockRejectedValueOnce(new Error('parse failed'));
      await uploadFile();
      expect(countUserFiles(userId)).toBe(0);
    });

    it('leaves zero files after two sequential throw-path uploads', async () => {
      mockParseUserCV.mockRejectedValue(new Error('always fails'));
      await uploadFile();
      await uploadFile();
      expect(countUserFiles(userId)).toBe(0);
    });

    it('leaves zero files after a burst of concurrent uploads (parallel cleanup)', async () => {
      // If three simultaneous requests each write ${userId}-<timestamp>.pdf,
      // all three must be cleaned up — post-condition check.
      mockParseUserCV.mockResolvedValue(validParsedCV);
      await Promise.all([uploadFile(), uploadFile(), uploadFile()]);
      expect(countUserFiles(userId)).toBe(0);
    });
  });
});
