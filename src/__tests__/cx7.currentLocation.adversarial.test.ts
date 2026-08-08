/**
 * ADVERSARIAL TEST — cx7 (onlyjobs-cx7)
 * currentLocation field on PUT /api/users/profile
 *
 * Assume the implementation is subtly WRONG; write tests that EXPOSE bugs.
 * Report pass/fail — failures are FINDINGS. Do NOT modify production code, do NOT commit.
 *
 * CONTRACT (oracle — every assertion traces here):
 *   - trimmed string is saved
 *   - null OR "" clears the field (previouslybroken — highest-value case)
 *   - string longer than 100 chars is REJECTED (non-2xx), existing value unchanged
 *   - updating currentLocation MUST NOT mutate preferences.location
 *   - updating preferences (PUT /users/preferences) MUST NOT mutate currentLocation
 *
 * FORBIDDEN FILES (NOT opened):
 *   src/controllers/userController.ts
 *
 * Files read: src/models/User.ts, src/routes/userRoutes.ts,
 *             src/__tests__/profile.test.ts, src/__tests__/setup.ts,
 *             src/__tests__/kda-d.adversarial.test.ts (harness pattern only)
 *
 * DISCLOSURE: see bottom of file.
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({}),
}));

jest.mock('bcrypt', () => ({
  hash: (_pw: string, _rounds: number) => Promise.resolve(`hashed_${_pw}`),
  compare: (pw: string, hash: string) => Promise.resolve(hash === `hashed_${pw}`),
}));

jest.mock('../services/emailService', () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(true),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(true),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import request from 'supertest';
import express from 'express';
import userRoutes from '../routes/userRoutes';
import User from '../models/User';
import { generateToken } from '../utils/generateToken';

// ── App fixture ───────────────────────────────────────────────────────────────
const testApp = express();
testApp.use(express.json());
testApp.use('/api/users', userRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
let seq = 0;
const makeUser = async (overrides: Record<string, any> = {}) => {
  seq++;
  const user = await User.create({
    email: `cx7-${seq}@adversarial.test`,
    password: 'hashed_pass',
    ...overrides,
  });
  return { user, token: generateToken(user.id) };
};

// ── CX7 adversarial suite ─────────────────────────────────────────────────────

describe('CX7 adversarial — PUT /api/users/profile: currentLocation', () => {

  // ── Case 1: NULL CLEAR ─────────────────────────────────────────────────────
  // Contract: null clears currentLocation. This was the previously-broken path.
  describe('Case 1 — NULL CLEAR (previously-broken path)', () => {
    it('returns 2xx when currentLocation: null is sent', async () => {
      const { token } = await makeUser({ currentLocation: 'India' });

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: null });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });

    it('response body has NO currentLocation after null clear', async () => {
      const { token } = await makeUser({ currentLocation: 'India' });

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: null });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      // Must be absent or undefined — not null, not empty string, not "India"
      expect(res.body.user.currentLocation).toBeUndefined();
    });

    it('DB re-fetch confirms currentLocation absent after null clear', async () => {
      const { user, token } = await makeUser({ currentLocation: 'India' });

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: null });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.currentLocation).toBeUndefined();
    });

    it('null clear does NOT accidentally null-out currentLocation (must be absent, not null)', async () => {
      const { user, token } = await makeUser({ currentLocation: 'India' });

      await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: null });

      const refreshed = await User.findById(user._id).lean();
      // Explicitly asserting NOT null — a null vs undefined distinction matters
      expect(refreshed?.currentLocation).not.toBeNull();
      expect(refreshed?.currentLocation).not.toBe('India');
    });
  });

  // ── Case 2: EMPTY STRING CLEAR ─────────────────────────────────────────────
  // Contract: "" also clears the field.
  describe('Case 2 — EMPTY STRING CLEAR', () => {
    it('returns 2xx when currentLocation: "" is sent', async () => {
      const { token } = await makeUser({ currentLocation: 'India' });

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: '' });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });

    it('response body has NO currentLocation after empty-string clear', async () => {
      const { token } = await makeUser({ currentLocation: 'India' });

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: '' });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.body.user.currentLocation).toBeUndefined();
    });

    it('DB re-fetch confirms currentLocation absent after empty-string clear', async () => {
      const { user, token } = await makeUser({ currentLocation: 'India' });

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: '' });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.currentLocation).toBeUndefined();
    });
  });

  // ── Case 3: TRIM ────────────────────────────────────────────────────────────
  // Contract: leading/trailing whitespace is stripped before saving.
  describe('Case 3 — TRIM', () => {
    it('saves trimmed value "United States" when "  United States  " is sent', async () => {
      const { token } = await makeUser();

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: '  United States  ' });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.body.user.currentLocation).toBe('United States');
    });

    it('DB re-fetch confirms trimmed value is stored', async () => {
      const { user, token } = await makeUser();

      await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: '  United States  ' });

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.currentLocation).toBe('United States');
    });

    it('internal whitespace is preserved — only leading/trailing is stripped', async () => {
      const { token } = await makeUser();

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: '  New York, NY  ' });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.body.user.currentLocation).toBe('New York, NY');
    });
  });

  // ── Case 4: LENGTH CAP ─────────────────────────────────────────────────────
  // Contract: strings > 100 chars are rejected; existing value unchanged.
  describe('Case 4 — LENGTH CAP (> 100 chars rejected)', () => {
    it('rejects a 101-char currentLocation with non-2xx', async () => {
      const { token } = await makeUser();

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: 'x'.repeat(101) });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('existing currentLocation is unchanged after a 101-char rejection', async () => {
      const { user, token } = await makeUser({ currentLocation: 'Original City' });

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: 'x'.repeat(101) });

      expect(res.status).toBeGreaterThanOrEqual(400);

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.currentLocation).toBe('Original City');
    });

    it('boundary: exactly 100-char string is ACCEPTED', async () => {
      const { token } = await makeUser();

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: 'A'.repeat(100) });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.body.user.currentLocation).toBe('A'.repeat(100));
    });

    it('boundary: 102-char string is also rejected', async () => {
      const { token } = await makeUser();

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: 'B'.repeat(102) });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ── Case 5: NON-DERIVATION A ───────────────────────────────────────────────
  // Contract: setting currentLocation MUST NOT touch preferences.location.
  describe('Case 5 — NON-DERIVATION A: currentLocation update must not mutate preferences.location', () => {
    it('preferences.location remains ["Remote"] after updating currentLocation to "India"', async () => {
      const { user, token } = await makeUser({
        preferences: { location: ['Remote'] },
      });

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: 'India' });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      // Response body: currentLocation set, preferences.location untouched
      expect(res.body.user.currentLocation).toBe('India');
      expect(res.body.user.preferences?.location).toEqual(['Remote']);
    });

    it('DB re-fetch confirms preferences.location still ["Remote"] after currentLocation update', async () => {
      const { user, token } = await makeUser({
        preferences: { location: ['Remote'] },
      });

      await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: 'India' });

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.currentLocation).toBe('India');
      expect(refreshed?.preferences?.location).toEqual(['Remote']);
    });

    it('preferences.location with multiple values is fully intact after currentLocation update', async () => {
      const { user, token } = await makeUser({
        preferences: { location: ['Remote', 'New York, NY', 'San Francisco'] },
      });

      await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: 'Austin, TX' });

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.preferences?.location).toEqual(['Remote', 'New York, NY', 'San Francisco']);
    });

    it('clearing currentLocation (null) also does not touch preferences.location', async () => {
      const { user, token } = await makeUser({
        currentLocation: 'India',
        preferences: { location: ['Remote'] },
      });

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: null });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.currentLocation).toBeUndefined();
      expect(refreshed?.preferences?.location).toEqual(['Remote']);
    });
  });

  // ── Case 6: NON-DERIVATION B ───────────────────────────────────────────────
  // Contract: updating preferences MUST NOT touch currentLocation.
  describe('Case 6 — NON-DERIVATION B: preferences update must not mutate currentLocation', () => {
    it('currentLocation remains "India" after PUT /preferences setting location=["United States"]', async () => {
      const { user, token } = await makeUser({
        currentLocation: 'India',
        preferences: { location: ['India'] },
      });

      const res = await request(testApp)
        .put('/api/users/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({ location: ['United States'] });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.preferences?.location).toEqual(['United States']);
      expect(refreshed?.currentLocation).toBe('India');
    });

    it('preferences update with multiple fields does not clear currentLocation', async () => {
      const { user, token } = await makeUser({
        currentLocation: 'Germany',
        preferences: { location: ['Germany'], remoteOnly: false },
      });

      const res = await request(testApp)
        .put('/api/users/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({ location: ['Germany', 'Netherlands'], remoteOnly: true, matchingEnabled: true });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.currentLocation).toBe('Germany');
    });

    it('DB re-fetch after preferences update still shows currentLocation "India"', async () => {
      const { user, token } = await makeUser({ currentLocation: 'India' });

      await request(testApp)
        .put('/api/users/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({ location: ['Canada'], matchingEnabled: true });

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.currentLocation).toBe('India');
    });
  });

  // ── Case 7: TYPE REJECTION ─────────────────────────────────────────────────
  // Contract: non-string, non-null values are rejected.
  describe('Case 7 — TYPE REJECTION (non-string, non-null)', () => {
    it('rejects a numeric currentLocation', async () => {
      const { token } = await makeUser();

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: 42 });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects an object currentLocation', async () => {
      const { token } = await makeUser();

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: { city: 'Paris' } });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects an array currentLocation', async () => {
      const { token } = await makeUser();

      const res = await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: ['India'] });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('existing value unchanged after object-type rejection', async () => {
      const { user, token } = await makeUser({ currentLocation: 'Tokyo' });

      await request(testApp)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentLocation: { city: 'Paris' } });

      const refreshed = await User.findById(user._id).lean();
      expect(refreshed?.currentLocation).toBe('Tokyo');
    });
  });
});

/**
 * DISCLOSURE
 * ----------
 * Files read during test authorship:
 *   1. src/models/User.ts — read to confirm field names (`currentLocation?: string`,
 *      `preferences.location: string[]`), schema trim: true on currentLocation, and
 *      that the two fields are independent paths in the schema. This confirms the
 *      non-derivation contract at the model level but reveals no controller logic.
 *   2. src/routes/userRoutes.ts — read only to confirm endpoint paths:
 *        PUT /profile  → updateUserProfile
 *        PUT /preferences → updatePreferences
 *      No implementation bodies seen.
 *   3. src/__tests__/profile.test.ts — read for the MongoMemoryServer + supertest +
 *      generateToken harness pattern. Incidentally saw the existing profile tests
 *      (which already cover empty-string clear and trim). I did NOT encode those
 *      tests' oracle values — every assertion here traces to the contract above,
 *      not to the existing test expectations.
 *   4. src/__tests__/setup.ts — read for the beforeAll/afterEach global setup pattern.
 *   5. src/__tests__/kda-d.adversarial.test.ts (top ~60 lines) — read for the
 *      mutable-currentUserId middleware-mock harness pattern; did not use that pattern
 *      here (followed profile.test.ts's generateToken approach instead).
 *
 * Nothing in the incidentally-seen profile.test.ts changed any assertions here:
 *   - Case 1 (null clear) is not covered there — it is the highest-value new case.
 *   - Case 5/6 (non-derivation) are not covered there.
 *   - Case 4 boundary at exactly 100 chars is adversarially chosen, not echoed from there.
 */
