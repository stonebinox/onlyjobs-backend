/**
 * xhbu Group 3 - captureCvUploadAttempt direct contract tests.
 *
 * Init note (from analytics.lifecycle.integration.adversarial.test.ts): the service lazily
 * initialises on first capture call, so POSTHOG_KEY must be set BEFORE the first call. Since
 * "no key" and "key set" need different init states, each describe block loads a fresh module
 * copy via jest.isolateModules after setting/unsetting the env.
 *
 * MUTATIONS CAUGHT: wrong event name; wrong/missing property; distinctId not userId;
 * fileType default not "unknown"; capture() throw propagating; capture called when no key;
 * capture called more/less than once.
 */
const mockCapture = jest.fn();
const mockShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({ capture: mockCapture, shutdown: mockShutdown })),
}));

type Svc = typeof import('../services/analyticsService');

function load(key: string | undefined): Svc {
  if (key === undefined) delete process.env.POSTHOG_KEY; else process.env.POSTHOG_KEY = key;
  let mod!: Svc;
  jest.isolateModules(() => { mod = require('../services/analyticsService'); });
  return mod;
}

beforeEach(() => { mockCapture.mockReset(); });
afterAll(() => { delete process.env.POSTHOG_KEY; });

describe('captureCvUploadAttempt - PostHog configured', () => {
  it('calls capture exactly once with exact event shape', () => {
    const svc = load('test-key');
    const ret = svc.captureCvUploadAttempt('user-123', {
      outcome: 'ok', reason: 'ok', retryable: false, fileType: 'pdf',
    });
    expect(ret).toBeUndefined();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-123',
      event: 'cv_upload_attempt',
      properties: { outcome: 'ok', reason: 'ok', retryable: false, fileType: 'pdf' },
    });
  });

  it('passes through failure outcome/reason and retryable=true (no falsy/truthy coercion)', () => {
    const svc = load('test-key');
    svc.captureCvUploadAttempt('u2', { outcome: 'failed', reason: 'transient', retryable: true, fileType: 'docx' });
    const arg = mockCapture.mock.calls[0][0];
    expect(arg.properties).toEqual({ outcome: 'failed', reason: 'transient', retryable: true, fileType: 'docx' });
    expect(arg.distinctId).toBe('u2');
  });

  it('defaults properties.fileType to "unknown" when omitted', () => {
    const svc = load('test-key');
    svc.captureCvUploadAttempt('u3', { outcome: 'failed', reason: 'unreadable', retryable: false });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0][0].properties).toEqual({
      outcome: 'failed', reason: 'unreadable', retryable: false, fileType: 'unknown',
    });
  });

  it('never throws and returns void synchronously when capture() throws', () => {
    const svc = load('test-key');
    mockCapture.mockImplementation(() => { throw new Error('posthog down'); });
    let ret: unknown = 'sentinel';
    expect(() => {
      ret = svc.captureCvUploadAttempt('u4', { outcome: 'ok', reason: 'ok', retryable: false, fileType: 'pdf' });
    }).not.toThrow();
    expect(ret).toBeUndefined();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});

describe('captureCvUploadAttempt - PostHog NOT configured', () => {
  it('is a no-op: does not throw and does not call capture', () => {
    const svc = load(undefined);
    expect(() =>
      svc.captureCvUploadAttempt('u5', { outcome: 'ok', reason: 'ok', retryable: false, fileType: 'pdf' })
    ).not.toThrow();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
