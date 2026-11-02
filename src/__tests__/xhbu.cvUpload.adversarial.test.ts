// Phase 2b adversarial route tests for POST /api/users/cv (oracle = task contract).
// Real app + real multer + real DB (mongodb-memory-server). Mocked: parseUserCV ONLY, analytics capture (spy).

const mockParse = jest.fn();
const mockCapture = jest.fn();

jest.mock('../services/userService', () => {
  const actual = jest.requireActual('../services/userService');
  return { ...actual, parseUserCV: (...a: any[]) => mockParse(...a) };
});
jest.mock('../services/analyticsService', () => {
  const actual = jest.requireActual('../services/analyticsService');
  return { ...actual, captureCvUploadAttempt: (...a: any[]) => mockCapture(...a) };
});

import request from 'supertest';
import app from '../app';
import User from '../models/User';
import { generateToken } from '../utils/generateToken';
import { CvParseError } from '../services/userService';

const GOOD_RESUME = {
  summary: 'Original good summary',
  skills: ['Go', 'Rust'],
  experience: ['Original Corp - Staff Eng'],
  education: ['MIT'],
  certifications: ['CKA'],
  languages: ['English'],
  projects: ['Proj A'],
  achievements: ['A'],
  volunteerExperience: ['V'],
  interests: ['I'],
};
const NEW_PARSED = {
  name: 'New Name',
  resume: { summary: 'New summary', skills: ['TS'], experience: ['New Co'], education: ['Uni'] },
  preferences: { jobTypes: ['contract'], location: ['Berlin'], remoteOnly: true, minSalary: 5, industries: ['x'] },
};
const pdfBuf = Buffer.from('%PDF-1.4 fake');

async function seedUser() {
  const user = await User.create({
    email: 'cv@example.com',
    password: 'hashed_pw',
    name: 'Original Name',
    resume: GOOD_RESUME,
    preferences: { jobTypes: ['full-time'], location: ['Paris'], remoteOnly: false, minSalary: 100, industries: ['fin'], minScore: 55, matchingEnabled: true },
    noResumeReminderCount: 3,
  });
  return { user, token: generateToken(user.id) };
}
const snapshot = async (id: string) => {
  const u: any = await User.findById(id).lean();
  return JSON.stringify({ name: u.name, resume: u.resume, preferences: u.preferences, c: u.noResumeReminderCount });
};
const post = (token: string, buf: Buffer | null, filename = 'cv.pdf', ct?: string) => {
  let r = request(app).post('/api/users/cv').set('Authorization', `Bearer ${token}`);
  if (buf) r = r.attach('file', buf, ct === undefined ? { filename } : { filename, contentType: ct });
  return r;
};

beforeEach(() => {
  mockParse.mockReset();
  mockCapture.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('HTTP contract on parse outcomes', () => {
  it('meaningful success => 200 + body, resume/name persisted, reminder count reset to 0', async () => {
    const { user, token } = await seedUser();
    mockParse.mockResolvedValue(NEW_PARSED);
    const res = await post(token, pdfBuf);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'CV uploaded successfully' });
    const u: any = await User.findById(user.id).lean();
    expect(u.name).toBe('New Name');
    expect(u.resume.summary).toBe('New summary');
    expect(u.resume.skills).toEqual(['TS']);
    expect(u.noResumeReminderCount).toBe(0); // catches missing reminder reset
  });

  it.each(['unreadable', 'invalid_output'] as const)('CvParseError %s => 422 retryable:false, user unchanged', async (code) => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    mockParse.mockRejectedValue(new CvParseError(code as any));
    const res = await post(token, pdfBuf);
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(code);
    expect(res.body.retryable).toBe(false);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(10);
    expect(await snapshot(user.id)).toBe(before); // catches mutate-before-parse / partial wipe
  });

  it('CvParseError transient => 503 retryable:true (catches 503 mislabeled as 422), user unchanged', async () => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    mockParse.mockRejectedValue(new CvParseError('transient' as any));
    const res = await post(token, pdfBuf);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: 'transient', retryable: true });
    expect(typeof res.body.message).toBe('string');
    expect(await snapshot(user.id)).toBe(before);
  });

  it('plain Error from parse => 500 with {message} (not {error}), user unchanged', async () => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    mockParse.mockRejectedValue(new Error('OpenAI API key not configured'));
    const res = await post(token, pdfBuf);
    expect(res.status).toBe(500);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.error).toBeUndefined();
    expect(await snapshot(user.id)).toBe(before);
  });
});

describe('DATA-LOSS regression: existing good resume survives bad uploads', () => {
  it.each([
    ['empty resume object', { name: 'Bad', resume: {}, preferences: {} }],
    ['blank fields only', { name: 'Bad', resume: { summary: ' ', skills: [], experience: [], education: [] }, preferences: {} }],
    ['only certifications/languages', { name: 'Bad', resume: { summary: '', certifications: ['X'], languages: ['Y'] }, preferences: {} }],
    ['null resume', { name: 'Bad', resume: null, preferences: {} }],
  ])('parse returns non-meaningful (%s) => NOT 200 and existing resume byte-identical', async (_l, parsed) => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    mockParse.mockResolvedValue(parsed);
    const res = await post(token, pdfBuf);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await snapshot(user.id)).toBe(before);
    const u: any = await User.findById(user.id).lean();
    expect(u.resume.summary).toBe('Original good summary');
    expect(u.name).toBe('Original Name');
    expect(u.preferences.minScore).toBe(55);
  });

  it('parse throws => resume, name, preferences, reminder count all untouched', async () => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    mockParse.mockRejectedValue(new CvParseError('invalid_output' as any));
    await post(token, pdfBuf);
    expect(await snapshot(user.id)).toBe(before);
  });

  it('REPEATED failures never erode data', async () => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    for (const e of [new CvParseError('transient' as any), new CvParseError('unreadable' as any), new Error('boom')]) {
      mockParse.mockRejectedValueOnce(e);
      await post(token, pdfBuf);
    }
    expect(await snapshot(user.id)).toBe(before);
  });
});

describe('multer rejections', () => {
  it('file > 10MB => 413 too_large retryable:false, parse never called, user unchanged', async () => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x61);
    const res = await post(token, big);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, code: 'too_large', retryable: false });
    expect(typeof res.body.message).toBe('string');
    expect(mockParse).not.toHaveBeenCalled();
    expect(await snapshot(user.id)).toBe(before);
  });

  it('unsupported type (.exe, application/x-msdownload) => 400 unsupported_type', async () => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    mockParse.mockRejectedValue(new CvParseError('unsupported_type'));
    const res = await post(token, Buffer.from('MZ'), 'evil.exe', 'application/x-msdownload');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      code: 'unsupported_type',
      retryable: false,
      message: 'Please upload a PDF or Word document.',
    });
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockCapture.mock.calls[0])).toContain('unsupported_type');
    expect(await snapshot(user.id)).toBe(before);
  });

  it('unsupported type (.png image/png) => 400 unsupported_type', async () => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    mockParse.mockRejectedValue(new CvParseError('unsupported_type'));
    const res = await post(token, Buffer.from('x'), 'a.png', 'image/png');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsupported_type');
    expect(await snapshot(user.id)).toBe(before);
  });

  it('no file => 400 { message: "Please upload a file" }, parse not called', async () => {
    const { user, token } = await seedUser();
    const before = await snapshot(user.id);
    const res = await post(token, null);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Please upload a file');
    expect(mockParse).not.toHaveBeenCalled();
    expect(await snapshot(user.id)).toBe(before);
  });

  it('wrong field name is not accepted as a file (no 500)', async () => {
    const { token } = await seedUser();
    const res = await request(app).post('/api/users/cv').set('Authorization', `Bearer ${token}`)
      .attach('resume', pdfBuf, { filename: 'cv.pdf' });
    expect(res.status).toBeLessThan(500);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('unauthenticated => 401, parse not called', async () => {
    const res = await request(app).post('/api/users/cv').attach('file', pdfBuf, { filename: 'cv.pdf' });
    expect(res.status).toBe(401);
    expect(mockParse).not.toHaveBeenCalled();
  });
});

describe('Safari/iOS content-type tolerance', () => {
  it.each([
    ['application/octet-stream'],
    [''],
  ])('x.pdf with Content-Type %p reaches parse path and succeeds', async (ct) => {
    const { token } = await seedUser();
    mockParse.mockResolvedValue(NEW_PARSED);
    // Raw multipart so an empty content-type is truly sent as such.
    const boundary = '----xhbuBoundary';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\n` +
      (ct === '' ? '' : `Content-Type: ${ct}\r\n`) + '\r\n';
    const body = Buffer.concat([Buffer.from(head), pdfBuf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await request(app).post('/api/users/cv')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(res.status).toBe(200); // catches octet-stream/empty rejected by file filter
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it('x.pdf with explicit application/octet-stream via attach also reaches parse', async () => {
    const { token } = await seedUser();
    mockParse.mockResolvedValue(NEW_PARSED);
    const res = await post(token, pdfBuf, 'x.pdf', 'application/octet-stream');
    expect(res.status).toBe(200);
    expect(mockParse).toHaveBeenCalledTimes(1);
  });
});

describe('analytics observability: exactly one attempt per terminal path', () => {
  const run = async (name: string, act: (token: string) => Promise<request.Response>, status: number, codeHint: string | null) => {
    const { token } = await seedUser();
    const res = await act(token);
    expect(res.status).toBe(status);
    expect(mockCapture).toHaveBeenCalledTimes(1); // catches missing capture on a path / double capture
    if (codeHint) expect(JSON.stringify(mockCapture.mock.calls[0])).toContain(codeHint);
    return res;
  };

  it('success', async () => {
    mockParse.mockResolvedValue(NEW_PARSED);
    await run('ok', (t) => post(t, pdfBuf), 200, null);
  });
  it('unreadable', async () => {
    mockParse.mockRejectedValue(new CvParseError('unreadable' as any));
    await run('u', (t) => post(t, pdfBuf), 422, 'unreadable');
  });
  it('invalid_output', async () => {
    mockParse.mockRejectedValue(new CvParseError('invalid_output' as any));
    await run('i', (t) => post(t, pdfBuf), 422, 'invalid_output');
  });
  it('transient', async () => {
    mockParse.mockRejectedValue(new CvParseError('transient' as any));
    await run('t', (t) => post(t, pdfBuf), 503, 'transient');
  });
  it('unexpected error (500)', async () => {
    mockParse.mockRejectedValue(new Error('boom'));
    await run('e', (t) => post(t, pdfBuf), 500, null);
  });
  it('too_large (multer rejection)', async () => {
    await run('tl', (t) => post(t, Buffer.alloc(10 * 1024 * 1024 + 1024, 0x61)), 413, 'too_large');
  });
  it('unsupported_type (parse-layer rejection)', async () => {
    mockParse.mockRejectedValue(new CvParseError('unsupported_type'));
    await run('ut', (t) => post(t, Buffer.from('MZ'), 'e.exe', 'application/x-msdownload'), 400, 'unsupported_type');
  });
  it('missing_file', async () => {
    await run('mf', (t) => post(t, null), 400, 'missing_file');
  });
  it('non-meaningful parse result is recorded exactly once too', async () => {
    mockParse.mockResolvedValue({ name: 'x', resume: {}, preferences: {} });
    const { token } = await seedUser();
    const res = await post(token, pdfBuf);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
