// Smoke test: happy-path cleanup — controller deletes the temp file after a successful parse.
// Full failure-path matrix is authored separately (adversarial suite).

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

// Same calculation the controller uses: __dirname of userController = src/controllers
const uploadsDir = path.resolve(__dirname, '../../uploads/cvs');

describe('POST /api/users/cv — temp file cleanup (le8)', () => {
  it('deletes the temp file after a successful 200 response', async () => {
    const user = await User.create({
      email: 'le8-cleanup@example.com',
      password: 'hashed_test',
    });
    const token = generateToken(user.id);
    const userId = user.id as string;

    mockParseUserCV.mockResolvedValueOnce({
      name: 'Test User',
      resume: {
        skills: ['TypeScript'],
        summary: 'Dev',
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
        minSalary: 50000,
        industries: ['Tech'],
      },
    });

    const res = await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 test'), {
        filename: 'resume.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(200);

    // The controller must have deleted its temp file — none matching this userId should remain.
    const remaining = fs.existsSync(uploadsDir)
      ? fs.readdirSync(uploadsDir).filter(f => f.startsWith(userId))
      : [];
    expect(remaining).toHaveLength(0);
  });
});
