process.env.JWT_SECRET = 'test-jwt-secret';

// Mock OpenAI before any imports to prevent module-level instantiation errors
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({}),
}));

// Mock bcrypt before any imports to avoid native binary architecture issues.
// The mock is deterministic: hash(pw) => "hashed_<pw>", compare(pw, hash) => hash === "hashed_<pw>"
jest.mock('bcrypt', () => ({
  hash: (_password: string, _saltRounds: number) =>
    Promise.resolve(`hashed_${_password}`),
  compare: (password: string, hash: string) =>
    Promise.resolve(hash === `hashed_${password}`),
}));

jest.mock('../services/emailService', () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(true),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(true),
}));

import crypto from 'crypto';
import request from 'supertest';
import express from 'express';
import userRoutes from '../routes/userRoutes';
import User from '../models/User';

const testApp = express();
testApp.use(express.json());
testApp.use('/api/users', userRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

describe('POST /api/users/auth', () => {
  it('creates a new user and returns token + id for a new email', async () => {
    const res = await request(testApp)
      .post('/api/users/auth')
      .send({ email: 'newuser@example.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.id).toBeDefined();
    expect(res.body.isNewUser).toBe(true);
  });

  it('returns token + id for existing email with correct password', async () => {
    // bcrypt mock: stored hash is "hashed_<password>"
    await User.create({
      email: 'existing@example.com',
      password: 'hashed_correctpassword',
    });

    const res = await request(testApp)
      .post('/api/users/auth')
      .send({ email: 'existing@example.com', password: 'correctpassword' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.id).toBeDefined();
    expect(res.body.isNewUser).toBe(false);
  });

  it('returns 401 for existing email with wrong password', async () => {
    await User.create({
      email: 'wrongpass@example.com',
      password: 'hashed_correctpassword',
    });

    const res = await request(testApp)
      .post('/api/users/auth')
      .send({ email: 'wrongpass@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/users/forgot-password', () => {
  it('returns 200 regardless of whether the email exists', async () => {
    const res = await request(testApp)
      .post('/api/users/forgot-password')
      .send({ email: 'doesnotexist@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account');
  });

  it('returns 200 for a real user email without revealing existence', async () => {
    await User.create({ email: 'realuser@example.com', password: 'hashed_somepassword' });

    const res = await request(testApp)
      .post('/api/users/forgot-password')
      .send({ email: 'realuser@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account');
  });
});

describe('POST /api/users/auth (duplicate email)', () => {
  it('returns 401 when registering email then logging in with a different password', async () => {
    // First call: registers a new user
    await request(testApp)
      .post('/api/users/auth')
      .send({ email: 'dupuser@example.com', password: 'originalpassword' });

    // Second call: same email, different password — treats it as a login attempt → wrong password → 401
    const res = await request(testApp)
      .post('/api/users/auth')
      .send({ email: 'dupuser@example.com', password: 'differentpassword' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/users/reset-password', () => {
  it('returns 400 for an invalid or expired reset token', async () => {
    const res = await request(testApp)
      .post('/api/users/reset-password')
      .send({ token: 'invalidtoken', newPassword: 'newpassword123' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for an expired reset token (token exists but is past expiry)', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    await User.create({
      email: 'expiredtoken@example.com',
      password: 'hashed_somepassword',
      passwordResetToken: hashedToken,
      passwordResetExpires: new Date(Date.now() - 1000), // already expired
    });

    const res = await request(testApp)
      .post('/api/users/reset-password')
      .send({ token: rawToken, newPassword: 'newpassword789' });

    expect(res.status).toBe(400);
  });

  it('resets password and returns 200 for a valid token', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    await User.create({
      email: 'resetuser@example.com',
      password: 'hashed_originalpassword',
      passwordResetToken: hashedToken,
      passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(testApp)
      .post('/api/users/reset-password')
      .send({ token: rawToken, newPassword: 'newpassword456' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Password reset successfully');

    // Confirm the password was actually updated in the DB (bcrypt mock: "hashed_<pw>")
    const updatedUser = await User.findOne({ email: 'resetuser@example.com' });
    expect(updatedUser).not.toBeNull();
    expect(updatedUser!.password).toBe('hashed_newpassword456');
    expect(updatedUser!.passwordResetToken).toBeUndefined();
  });
});

describe('POST /api/users/verify-email', () => {
  it('returns 200 and marks user as verified for a valid verification token', async () => {
    const token = crypto.randomBytes(32).toString('hex');

    await User.create({
      email: 'unverified@example.com',
      password: 'hashed_somepassword',
      emailVerificationToken: token,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      isVerified: false,
    });

    const res = await request(testApp)
      .post('/api/users/verify-email')
      .send({ token });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('verified');

    const verifiedUser = await User.findOne({ email: 'unverified@example.com' });
    expect(verifiedUser).not.toBeNull();
    expect(verifiedUser!.isVerified).toBe(true);
    expect(verifiedUser!.emailVerificationToken).toBeUndefined();
  });
});
