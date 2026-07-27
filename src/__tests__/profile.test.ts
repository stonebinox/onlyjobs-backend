process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({}),
}));

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

const createUserAndToken = async (overrides: Record<string, any> = {}) => {
  const user = await User.create({
    email: 'test@example.com',
    password: 'hashed_password123',
    ...overrides,
  });
  const token = generateToken(user.id);
  return { user, token };
};

describe('GET /api/users/profile', () => {
  it('returns currentLocation when set', async () => {
    const { token } = await createUserAndToken({ currentLocation: 'London, UK' });

    const res = await request(testApp)
      .get('/api/users/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.currentLocation).toBe('London, UK');
  });

  it('returns undefined currentLocation when not set', async () => {
    const { token } = await createUserAndToken();

    const res = await request(testApp)
      .get('/api/users/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.currentLocation).toBeUndefined();
  });
});

describe('PUT /api/users/profile', () => {
  it('sets currentLocation successfully', async () => {
    const { token } = await createUserAndToken();

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentLocation: 'San Francisco, CA' });

    expect(res.status).toBe(200);
    expect(res.body.user.currentLocation).toBe('San Francisco, CA');
  });

  it('rejects non-string currentLocation with 400', async () => {
    const { token } = await createUserAndToken();

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentLocation: 123 });

    expect(res.status).toBe(400);
  });

  it('clears currentLocation when empty string is sent', async () => {
    const { token, user } = await createUserAndToken({ currentLocation: 'London, UK' });

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentLocation: '' });

    expect(res.status).toBe(200);
    expect(res.body.user.currentLocation).toBeUndefined();

    const updated = await User.findById(user._id);
    expect(updated?.currentLocation).toBeUndefined();
  });

  it('trims whitespace from currentLocation', async () => {
    const { token } = await createUserAndToken();

    const res = await request(testApp)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentLocation: '  Berlin, Germany  ' });

    expect(res.status).toBe(200);
    expect(res.body.user.currentLocation).toBe('Berlin, Germany');
  });
});

// ---------------------------------------------------------------------------
// PUT /api/users/preferences — matchingDisabledReason stamping
// ---------------------------------------------------------------------------

describe('PUT /api/users/preferences — matchingDisabledReason', () => {
  it('stamps matchingDisabledReason="user" when user disables matching', async () => {
    const { user, token } = await createUserAndToken({
      preferences: { matchingEnabled: true },
    });

    const res = await request(testApp)
      .put('/api/users/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchingEnabled: false });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.preferences.matchingEnabled).toBe(false);
    expect(updated!.matchingDisabledReason).toBe('user');
  });

  it('clears matchingDisabledReason when user re-enables matching', async () => {
    const { user, token } = await createUserAndToken({
      preferences: { matchingEnabled: false },
      matchingDisabledReason: 'user',
    });

    const res = await request(testApp)
      .put('/api/users/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchingEnabled: true });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.preferences.matchingEnabled).toBe(true);
    expect(updated!.matchingDisabledReason).toBeUndefined();
  });

  it('REGRESSION: does not overwrite matchingDisabledReason="auto_low_balance" when no matching transition occurs', async () => {
    // User was auto-disabled due to low balance. Frontend always sends matchingEnabled
    // in the payload even when updating other prefs. The reason must survive untouched.
    const { user, token } = await createUserAndToken({
      preferences: { matchingEnabled: false, jobTypes: ['full_time'] },
      matchingDisabledReason: 'auto_low_balance',
    });

    const res = await request(testApp)
      .put('/api/users/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ matchingEnabled: false, jobTypes: ['full_time', 'contract'] });

    expect(res.status).toBe(200);

    const updated = await User.findById(user._id);
    expect(updated!.preferences.matchingEnabled).toBe(false);
    expect(updated!.matchingDisabledReason).toBe('auto_low_balance');
  });
});
