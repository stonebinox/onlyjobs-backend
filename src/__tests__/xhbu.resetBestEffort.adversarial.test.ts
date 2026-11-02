/**
 * xhbu Group 1 - reminder reset is best-effort.
 *
 * CONTRACT: POST /api/users/cv, when parseUserCV returns a MEANINGFUL resume, must persist the
 * resume and return 200 EVEN IF resetNoResumeReminderState fails. The reset is a secondary
 * best-effort DB write; its failure must NOT turn a saved CV into a 500.
 *
 * MUTATION CAUGHT: an implementation that awaits resetNoResumeReminderState outside a
 * try/catch (or rethrows) lets the rejection reach the error handler -> 500. This test
 * fails on that mutation (status 500 instead of 200).
 */
const mockParseUserCV = jest.fn();
const mockReset = jest.fn();

jest.mock('../services/userService', () => ({
  ...jest.requireActual('../services/userService'),
  parseUserCV: (...args: any[]) => mockParseUserCV(...args),
}));

jest.mock('../utils/resumeState', () => ({
  ...jest.requireActual('../utils/resumeState'),
  resetNoResumeReminderState: (...args: any[]) => mockReset(...args),
}));

jest.mock('../services/emailService', () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(undefined),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(undefined),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/razorpayService', () => ({
  createOrder: jest.fn(), verifyPayment: jest.fn(), verifyWebhookSignature: jest.fn(), fetchOrder: jest.fn(),
}));
jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../services/matchingService', () => ({
  matchUserToJob: jest.fn(),
  deleteAllMatches: jest.fn().mockResolvedValue(undefined),
  getMatchesData: jest.fn().mockResolvedValue([]),
  markMatchAsClicked: jest.fn().mockResolvedValue(undefined),
  skipMatch: jest.fn().mockResolvedValue(null),
  markMatchAppliedStatus: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/preferenceLearningService', () => ({
  analyzeRejectionAndUpdatePreferences: jest.fn().mockResolvedValue(null),
}));
jest.mock('bcrypt', () => ({
  hash: (pw: string) => Promise.resolve(`hashed_${pw}`),
  compare: (pw: string, h: string) => Promise.resolve(h === `hashed_${pw}`),
}));
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({ chat: { completions: { create: jest.fn() } } }),
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import userRoutes from '../routes/userRoutes';

let currentUser: any = null;
const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => { if (currentUser) req.user = currentUser; next(); });
app.use('/api/users', userRoutes);
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

beforeAll(() => { process.env.JWT_SECRET = 'test-jwt-secret'; });
beforeEach(() => { mockParseUserCV.mockReset(); mockReset.mockReset(); currentUser = null; });

describe('xhbu: reminder reset failure must not fail a saved CV', () => {
  it('returns 200 + success and persists resume when resetNoResumeReminderState rejects', async () => {
    const userId = new mongoose.Types.ObjectId();
    const user = await User.create({
      _id: userId,
      email: `u-${userId}@test.example.com`,
      password: 'hashed_pass',
      isVerified: true,
      noResumeReminderCount: 2,
    });
    currentUser = user;

    mockParseUserCV.mockResolvedValue({
      name: 'Jane Doe',
      resume: {
        summary: 'Backend engineer with ten years of distributed systems experience',
        skills: ['TypeScript', 'Node.js'],
        experience: [], education: [],
      },
      preferences: {},
    });
    mockReset.mockRejectedValue(new Error('simulated reminder-reset DB failure'));

    const res = await request(app)
      .post('/api/users/cv')
      .attach('file', Buffer.from('%PDF-1.4\n' + 'resume body '.repeat(50)), {
        filename: 'resume.pdf', contentType: 'application/pdf',
      });

    // Precondition: the reset was actually attempted (else the test proves nothing).
    expect(mockReset).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const fresh: any = await User.findById(userId).lean();
    expect(fresh.resume.summary).toContain('Backend engineer');
    expect(fresh.resume.skills).toEqual(expect.arrayContaining(['TypeScript']));
  });
});
