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
  parseUserCV: jest.fn(),
  answerQuestion: jest.fn(),
  findUserByEmail: jest.fn(),
  getAIQuestion: jest.fn(),
  getAnswerForQuestion: jest.fn(),
  getUserNameById: jest.fn(),
  getUserQnA: jest.fn(),
  parseAudioAnswer: jest.fn(),
  skipQuestion: jest.fn(),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import fs from 'fs';
import userRoutes from '../routes/userRoutes';
import User from '../models/User';
import { generateToken } from '../utils/generateToken';
import { parseUserCV } from '../services/userService';

const mockParseUserCV = parseUserCV as jest.MockedFunction<typeof parseUserCV>;
const mockUnlinkSync = fs.unlinkSync as jest.Mock;

const testApp = express();
testApp.use(express.json());
testApp.use('/api/users', userRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

describe('POST /api/users/cv — parseUserCV returns null', () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockParseUserCV.mockResolvedValue(null);

    const user = await User.create({
      email: 'cvtest@example.com',
      password: 'hashed_password123',
      name: 'Original Name',
    });
    userId = user.id;
    token = generateToken(user.id);
  });

  it('returns 422 (not 500) when CV cannot be parsed', async () => {
    const res = await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF fake'), { filename: 'test.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(422);
  });

  it('returns a message field in the response body', async () => {
    const res = await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF fake'), { filename: 'test.pdf', contentType: 'application/pdf' });

    expect(res.body.message).toBeTruthy();
  });

  it('does NOT change user fields when CV parse fails', async () => {
    await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF fake'), { filename: 'test.pdf', contentType: 'application/pdf' });

    const user = await User.findById(userId);
    expect(user!.name).toBe('Original Name');
  });

  it('calls fs.unlinkSync to clean up the temp file', async () => {
    await request(testApp)
      .post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF fake'), { filename: 'test.pdf', contentType: 'application/pdf' });

    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
  });
});
