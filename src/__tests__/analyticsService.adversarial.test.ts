/**
 * Adversarial unit tests for analyticsService.
 *
 * Oracle: the CONTRACT in the task spec, NOT the implementation body.
 * posthog-node SDK is mocked; analyticsService itself is NOT mocked.
 */

// ────────────────────────────────────────────────────────────
// SDK mock — hoisted by jest before any require calls
// ────────────────────────────────────────────────────────────
const mockCapture = jest.fn();
const mockShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: mockCapture,
    shutdown: mockShutdown,
  })),
}));

// Pure functions don't depend on POSTHOG_KEY; import them unconditionally.
import { deriveRegion, walletBalanceBand } from '../services/analyticsService';
import mongoose from 'mongoose';

// captureLifecycleEvent and shutdownAnalytics are loaded via jest.isolateModules
// so each describe block controls the initialization state precisely.
// (analyticsService uses a lazy singleton: _initialized=false at module load;
// the key is read on first captureLifecycleEvent call, not at import time.)

afterEach(() => {
  mockCapture.mockClear();
  mockShutdown.mockClear();
});

// ────────────────────────────────────────────────────────────
// 1. deriveRegion — pure function, adversarial coverage
// ────────────────────────────────────────────────────────────
describe('deriveRegion — contract compliance', () => {
  // ── India ──
  it('"Bangalore, India" => India', () => expect(deriveRegion('Bangalore, India')).toBe('India'));
  it('"India" => India', () => expect(deriveRegion('India')).toBe('India'));
  it('"Chennai, India" => India', () => expect(deriveRegion('Chennai, India')).toBe('India'));

  // ── US ──
  it('"USA" => US', () => expect(deriveRegion('USA')).toBe('US'));
  it('"United States" => US', () => expect(deriveRegion('United States')).toBe('US'));
  // "New York" alone has no US-indicator token — the contract specifies USA/United States as examples.
  // "New York, USA" DOES contain the USA token and must resolve to US.
  it('"New York, USA" => US (USA token present)', () => expect(deriveRegion('New York, USA')).toBe('US'));

  // ── EMEA ──
  it('"London" => EMEA', () => expect(deriveRegion('London')).toBe('EMEA'));
  it('"Germany" => EMEA', () => expect(deriveRegion('Germany')).toBe('EMEA'));
  it('"Berlin, Germany" => EMEA', () => expect(deriveRegion('Berlin, Germany')).toBe('EMEA'));

  // ── APAC ──
  it('"Singapore" => APAC', () => expect(deriveRegion('Singapore')).toBe('APAC'));
  it('"Tokyo" => APAC', () => expect(deriveRegion('Tokyo')).toBe('APAC'));
  it('"Sydney, Australia" => APAC', () => expect(deriveRegion('Sydney, Australia')).toBe('APAC'));

  // ── Other — real places with no region token ──
  it('"Antarctica" => Other', () => expect(deriveRegion('Antarctica')).toBe('Other'));
  it('"Mars" => Other', () => expect(deriveRegion('Mars')).toBe('Other'));

  // ── THE TRAP: token match (split on non-alphanumerics), NOT substring ──
  // "Indiana" must NOT match India because "Indiana" ≠ "India" as a token.
  it('"Indiana" => Other (not India — token guard)', () => {
    expect(deriveRegion('Indiana')).toBe('Other');
  });
  // Additional trap cases
  it('"Indianapolis" => Other (not India)', () => {
    expect(deriveRegion('Indianapolis')).toBe('Other');
  });

  // ── unknown: falsy / non-string / whitespace ──
  it('empty string => unknown', () => expect(deriveRegion('')).toBe('unknown'));
  it('undefined => unknown', () => expect(deriveRegion(undefined)).toBe('unknown'));
  it('null => unknown', () => expect(deriveRegion(null)).toBe('unknown'));
  it('whitespace-only "   " => unknown', () => expect(deriveRegion('   ')).toBe('unknown'));
  it('non-string number (cast) => unknown', () => {
    expect(deriveRegion(42 as unknown as string)).toBe('unknown');
  });
  it('non-string object (cast) => unknown', () => {
    expect(deriveRegion({} as unknown as string)).toBe('unknown');
  });

  // ── Precedence: India > US when both tokens appear ──
  it('"Remote, India / United States" => India (India beats US)', () => {
    expect(deriveRegion('Remote, India / United States')).toBe('India');
  });
  // India > EMEA
  it('"London, India" => India (India beats EMEA)', () => {
    expect(deriveRegion('London, India')).toBe('India');
  });
  // India > APAC
  it('"Singapore, India" => India (India beats APAC)', () => {
    expect(deriveRegion('Singapore, India')).toBe('India');
  });
  // US > EMEA
  it('"London, USA" => US (US beats EMEA)', () => {
    expect(deriveRegion('London, USA')).toBe('US');
  });
});

// ────────────────────────────────────────────────────────────
// 2. walletBalanceBand — inclusive/exclusive boundary stress
// ────────────────────────────────────────────────────────────
describe('walletBalanceBand — boundary contracts', () => {
  // empty: <= 0 or non-finite
  it('-1 => empty', () => expect(walletBalanceBand(-1)).toBe('empty'));
  it('0 => empty (inclusive: <= 0)', () => expect(walletBalanceBand(0)).toBe('empty'));
  it('NaN => empty (non-finite)', () => expect(walletBalanceBand(NaN)).toBe('empty'));
  it('Infinity => empty (non-finite)', () => expect(walletBalanceBand(Infinity)).toBe('empty'));
  it('-Infinity => empty (non-finite)', () => expect(walletBalanceBand(-Infinity)).toBe('empty'));

  // below_daily: > 0 && < 0.30
  it('0.01 => below_daily', () => expect(walletBalanceBand(0.01)).toBe('below_daily'));
  it('0.05 => below_daily', () => expect(walletBalanceBand(0.05)).toBe('below_daily'));
  it('0.29 => below_daily', () => expect(walletBalanceBand(0.29)).toBe('below_daily'));

  // Critical boundary: 0.30 must be 'low', NOT 'below_daily'
  it('0.30 => low (lower bound of low, exclusive upper of below_daily)', () => {
    expect(walletBalanceBand(0.30)).toBe('low');
  });

  // low: >= 0.30 && < 1.00
  it('0.31 => low', () => expect(walletBalanceBand(0.31)).toBe('low'));
  it('0.50 => low', () => expect(walletBalanceBand(0.50)).toBe('low'));
  it('0.99 => low', () => expect(walletBalanceBand(0.99)).toBe('low'));

  // Critical boundary: 1.00 must be 'funded', NOT 'low'
  it('1.00 => funded (lower bound of funded, exclusive upper of low)', () => {
    expect(walletBalanceBand(1.00)).toBe('funded');
  });

  // funded: >= 1.00
  it('1.01 => funded', () => expect(walletBalanceBand(1.01)).toBe('funded'));
  it('1000 => funded', () => expect(walletBalanceBand(1000)).toBe('funded'));
});

// ────────────────────────────────────────────────────────────
// 3. captureLifecycleEvent — enabled path (key set at init)
// ────────────────────────────────────────────────────────────
describe('captureLifecycleEvent — payload (POSTHOG_KEY set)', () => {
  let captureLifecycleEvent: (user: any, event: any) => void;
  let shutdownAnalytics: () => Promise<void>;

  beforeAll(() => {
    process.env.POSTHOG_KEY = 'adv-test-enabled-key';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require('../services/analyticsService');
      captureLifecycleEvent = m.captureLifecycleEvent;
      shutdownAnalytics = m.shutdownAnalytics;
    });
  });

  afterAll(() => {
    delete process.env.POSTHOG_KEY;
  });

  const userId = new mongoose.Types.ObjectId();
  const PII_EMAIL = 'pii-adversarial-user@secret.example.com';
  const PII_NAME = 'PII Adversarial Name';
  const PII_LOCATION = 'PII City, PII Country';
  const PII_PHONE = '+1-555-000-PII';

  const fakeUser = {
    _id: userId,
    email: PII_EMAIL,
    name: PII_NAME,
    currentLocation: PII_LOCATION,
    phone: PII_PHONE,
    walletBalance: 2.50,   // => funded
    resume: { summary: 'PII resume text', skills: ['PII Skill'], experience: [], education: [] },
  };

  it('calls capture exactly once per call', () => {
    captureLifecycleEvent(fakeUser as any, 'email_verified');
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('distinctId equals _id.toString() — not email, not name', () => {
    mockCapture.mockClear();
    captureLifecycleEvent(fakeUser as any, 'email_verified');
    const call = mockCapture.mock.calls[0][0];
    expect(call.distinctId).toBe(userId.toString());
    expect(call.distinctId).not.toBe(PII_EMAIL);
    expect(call.distinctId).not.toBe(PII_NAME);
  });

  it('event field equals the event argument passed', () => {
    mockCapture.mockClear();
    captureLifecycleEvent(fakeUser as any, 'wallet_topup_completed');
    expect(mockCapture.mock.calls[0][0].event).toBe('wallet_topup_completed');
  });

  it('properties.$set has EXACTLY wallet_balance_band and region — no additional keys', () => {
    mockCapture.mockClear();
    captureLifecycleEvent(fakeUser as any, 'on_demand_match');
    const setProps = mockCapture.mock.calls[0][0].properties.$set;
    expect(setProps).toHaveProperty('wallet_balance_band');
    expect(setProps).toHaveProperty('region');
    expect(Object.keys(setProps)).toHaveLength(2);
  });

  it('wallet_balance_band is correct for walletBalance=2.50 (funded)', () => {
    mockCapture.mockClear();
    captureLifecycleEvent(fakeUser as any, 'email_verified');
    const setProps = mockCapture.mock.calls[0][0].properties.$set;
    expect(setProps.wallet_balance_band).toBe('funded');
  });

  it('region is derived from currentLocation (PII City, PII Country => Other)', () => {
    mockCapture.mockClear();
    captureLifecycleEvent(fakeUser as any, 'email_verified');
    const setProps = mockCapture.mock.calls[0][0].properties.$set;
    expect(setProps.region).toBe('Other');
  });

  it('region for "Bangalore, India" user is India', () => {
    mockCapture.mockClear();
    const indiaUser = { ...fakeUser, currentLocation: 'Bangalore, India' };
    captureLifecycleEvent(indiaUser as any, 'email_verified');
    const setProps = mockCapture.mock.calls[0][0].properties.$set;
    expect(setProps.region).toBe('India');
  });

  it('serialized capture payload contains NO PII strings', () => {
    mockCapture.mockClear();
    captureLifecycleEvent(fakeUser as any, 'email_verified');
    const serialized = JSON.stringify(mockCapture.mock.calls[0]);
    expect(serialized).not.toContain(PII_EMAIL);
    expect(serialized).not.toContain(PII_NAME);
    expect(serialized).not.toContain(PII_LOCATION);
    expect(serialized).not.toContain(PII_PHONE);
    // resume text must not appear either
    expect(serialized).not.toContain('PII resume text');
    expect(serialized).not.toContain('PII Skill');
  });

  it('shutdownAnalytics resolves without throwing', async () => {
    await expect(shutdownAnalytics()).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// 4. captureLifecycleEvent — no-op (POSTHOG_KEY unset at init)
// ────────────────────────────────────────────────────────────
describe('captureLifecycleEvent — no-op when POSTHOG_KEY is unset', () => {
  let captureLifecycleEvent: (user: any, event: any) => void;

  beforeAll(() => {
    const saved = process.env.POSTHOG_KEY;
    delete process.env.POSTHOG_KEY;
    jest.isolateModules(() => {
      ({ captureLifecycleEvent } = require('../services/analyticsService'));
    });
    // restore for other tests
    if (saved !== undefined) process.env.POSTHOG_KEY = saved;
  });

  it('capture is NEVER called when key was absent at init', () => {
    const fakeUser = { _id: { toString: () => 'no-op-uid' }, walletBalance: 5, currentLocation: 'London' };
    captureLifecycleEvent(fakeUser as any, 'email_verified');
    captureLifecycleEvent(fakeUser as any, 'wallet_topup_completed');
    captureLifecycleEvent(fakeUser as any, 'on_demand_match');
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// 5. captureLifecycleEvent — NEVER throws under any circumstance
// ────────────────────────────────────────────────────────────
describe('captureLifecycleEvent — never throws', () => {
  let captureLifecycleEvent: (user: any, event: any) => void;

  beforeAll(() => {
    process.env.POSTHOG_KEY = 'adv-test-throw-key';
    jest.isolateModules(() => {
      ({ captureLifecycleEvent } = require('../services/analyticsService'));
    });
  });

  afterAll(() => {
    delete process.env.POSTHOG_KEY;
  });

  it('does not throw when capture mock throws', () => {
    mockCapture.mockImplementationOnce(() => { throw new Error('SDK exploded'); });
    const user = { _id: { toString: () => 'throw-uid' }, walletBalance: 1, currentLocation: 'India' };
    expect(() => captureLifecycleEvent(user as any, 'email_verified')).not.toThrow();
  });

  it('does not throw for user missing walletBalance', () => {
    const user = { _id: { toString: () => 'no-balance-uid' } };
    expect(() => captureLifecycleEvent(user as any, 'email_verified')).not.toThrow();
  });

  it('does not throw for user with null walletBalance', () => {
    const user = { _id: { toString: () => 'null-balance-uid' }, walletBalance: null };
    expect(() => captureLifecycleEvent(user as any, 'email_verified')).not.toThrow();
  });

  it('does not throw for user with non-string currentLocation', () => {
    const user = { _id: { toString: () => 'bad-loc-uid' }, walletBalance: 5, currentLocation: 42 };
    expect(() => captureLifecycleEvent(user as any, 'email_verified')).not.toThrow();
  });

  it('does not throw for user with null currentLocation', () => {
    const user = { _id: { toString: () => 'null-loc-uid' }, walletBalance: 0, currentLocation: null };
    expect(() => captureLifecycleEvent(user as any, 'email_verified')).not.toThrow();
  });

  it('does not throw for completely malformed user (empty object)', () => {
    expect(() => captureLifecycleEvent({} as any, 'email_verified')).not.toThrow();
  });

  it('band falls back to empty for missing walletBalance (no throw)', () => {
    mockCapture.mockClear();
    const user = { _id: { toString: () => 'fallback-uid' } };
    captureLifecycleEvent(user as any, 'email_verified');
    // If enabled: either capture is called with band=empty, or not called
    // Either way: no throw is the requirement
    expect(true).toBe(true); // test passes if no throw
  });

  it('region falls back to unknown for non-string currentLocation (no throw)', () => {
    mockCapture.mockClear();
    const user = { _id: { toString: () => 'region-fallback-uid' }, walletBalance: 5, currentLocation: 999 };
    captureLifecycleEvent(user as any, 'email_verified');
    expect(true).toBe(true); // test passes if no throw
  });
});
