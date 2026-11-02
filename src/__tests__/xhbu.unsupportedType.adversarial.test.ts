/**
 * xhbu adversarial: "unsupported_type" CV rejection.
 * Parser tests: REAL parseUserCV, mocked pdf-parse / mammoth / openai.
 * Route tests: REAL express + multer + mongodb-memory-server, mocked parseUserCV only
 * (CvParseError and everything else in userService stays real).
 */

const mockPdfParse = jest.fn();
jest.mock('pdf-parse', () => {
  const fn: any = (...args: any[]) => mockPdfParse(...args);
  fn.default = fn;
  return fn;
});

const mockExtractRawText = jest.fn();
jest.mock('mammoth', () => {
  const obj: any = { extractRawText: (...a: any[]) => mockExtractRawText(...a) };
  return { __esModule: true, default: obj, extractRawText: obj.extractRawText };
});

const mockOpenAICreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: (...a: any[]) => mockOpenAICreate(...a) } },
    audio: { transcriptions: { create: jest.fn() } },
  })),
}));

const mockParseUserCV = jest.fn();
jest.mock('../services/userService', () => {
  const actual = jest.requireActual('../services/userService');
  return { ...actual, parseUserCV: (...a: any[]) => mockParseUserCV(...a) };
});
// Parser-unit tests need the REAL parseUserCV.
const realUserService = jest.requireActual('../services/userService');

const mockCaptureAttempt = jest.fn();
jest.mock('../services/analyticsService', () => {
  const actual = jest.requireActual('../services/analyticsService');
  return { ...actual, captureCvUploadAttempt: (...a: any[]) => mockCaptureAttempt(...a) };
});

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({ capture: jest.fn(), shutdown: jest.fn() })),
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

import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import User from '../models/User';
import userRoutes from '../routes/userRoutes';

const { parseUserCV, CvParseError } = realUserService;

// ─── parser-unit helpers ─────────────────────────────────────────────────────
let tmpDir: string;
beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-key';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhbu-unsup-'));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  mockPdfParse.mockReset();
  mockExtractRawText.mockReset();
  mockOpenAICreate.mockReset();
  mockParseUserCV.mockReset();
  mockCaptureAttempt.mockReset();
});

function writeFile(name: string, content: Buffer | string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

async function catchErr(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('parseUserCV: magic-byte gate (real function)', () => {
  const unsupportedCases: Array<[string, string, Buffer]> = [
    ['PNG header', 'a.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('\r\n\x1a\n rest of image')])],
    ['plain text', 'a.txt', Buffer.from('hello this is a plain text resume with enough words in it')],
    ['random bytes', 'a.dat', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x10, 0x20, 0x30])],
    ['lowercase pdf marker', 'a.dat2', Buffer.from('%pdf-1.4 lowercase')],
    ['leading whitespace before %PDF', 'a.dat3', Buffer.from('  %PDF-1.4 body')],
    ['lone P (one byte of PK)', 'a.dat4', Buffer.from('P not a zip')],
    ['PL (wrong second byte)', 'a.dat5', Buffer.from('PL\x03\x04')],
    ['kp (wrong order)', 'a.dat6', Buffer.from('KP\x03\x04')],
  ];

  it.each(unsupportedCases)('throws CvParseError unsupported_type for %s', async (_label, name, content) => {
    // catches: wrong code string / falling through to a generic code / no throw
    const err = await catchErr(parseUserCV(writeFile(name, content)));
    expect(err).toBeInstanceOf(CvParseError);
    expect(err.name).toBe('CvParseError');
    expect(err.code).toBe('unsupported_type');
  });

  it.each(unsupportedCases)('never calls OpenAI, pdf-parse, or mammoth for %s', async (_label, name, content) => {
    // catches: rejection happening after the model call (cost leak) or after an extractor ran
    await catchErr(parseUserCV(writeFile(`o-${name}`, content)));
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(mockPdfParse).not.toHaveBeenCalled();
    expect(mockExtractRawText).not.toHaveBeenCalled();
  });

  it('empty file is rejected as unsupported_type (no magic bytes) and not sent to OpenAI', async () => {
    // catches: empty file crashing with non-CvParseError or reaching the model
    const err = await catchErr(parseUserCV(writeFile('empty.pdf', Buffer.alloc(0))));
    expect(err).toBeInstanceOf(CvParseError);
    expect(err.code).toBe('unsupported_type');
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it('a file named .pdf with PNG content is unsupported_type (extension ignored)', async () => {
    // catches: gate on filename extension instead of content
    const err = await catchErr(parseUserCV(writeFile('resume.pdf', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))));
    expect(err?.code).toBe('unsupported_type');
    expect(mockPdfParse).not.toHaveBeenCalled();
  });

  it('a file named .docx with plain-text content is unsupported_type', async () => {
    // catches: extension-based dispatch for docx
    const err = await catchErr(parseUserCV(writeFile('resume.docx', 'just some text, not a zip')));
    expect(err?.code).toBe('unsupported_type');
    expect(mockExtractRawText).not.toHaveBeenCalled();
  });

  it('%PDF content with a .txt name is NOT unsupported_type (routed to pdf extractor)', async () => {
    // catches: extension-based rejection of a valid-header file
    mockPdfParse.mockResolvedValue({ text: '' });
    const err = await catchErr(parseUserCV(writeFile('resume.txt', '%PDF-1.4\nbody')));
    expect(mockPdfParse).toHaveBeenCalledTimes(1);
    expect(err?.code).not.toBe('unsupported_type');
  });

  it('PK content with a .bin name is NOT unsupported_type (routed to mammoth)', async () => {
    // catches: extension-based rejection of docx-header file
    mockExtractRawText.mockResolvedValue({ value: '' });
    const err = await catchErr(parseUserCV(writeFile('resume.bin', Buffer.from('PK\x03\x04 zipbody'))));
    expect(mockExtractRawText).toHaveBeenCalledTimes(1);
    expect(err?.code).not.toBe('unsupported_type');
  });

  it('%PDF header but pdf-parse throws => CvParseError "unreadable", NOT unsupported_type', async () => {
    // catches: lumping every extraction failure into unsupported_type
    mockPdfParse.mockRejectedValue(new Error('Invalid PDF structure'));
    const err = await catchErr(parseUserCV(writeFile('corrupt.pdf', '%PDF-1.4 garbage garbage')));
    expect(err).toBeInstanceOf(CvParseError);
    expect(err.code).toBe('unreadable');
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it('PK header but mammoth throws => CvParseError "unreadable", NOT unsupported_type', async () => {
    // catches: lumping docx extraction failure into unsupported_type
    mockExtractRawText.mockRejectedValue(new Error('Could not find the body element'));
    const err = await catchErr(parseUserCV(writeFile('corrupt.docx', Buffer.from('PK\x03\x04 corrupt'))));
    expect(err).toBeInstanceOf(CvParseError);
    expect(err.code).toBe('unreadable');
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it('CvParseError carries name and code and is an Error', () => {
    // catches: missing name / code on the exported class
    const e = new CvParseError('unsupported_type');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CvParseError');
    expect(e.code).toBe('unsupported_type');
  });
});

// ─── route tests ─────────────────────────────────────────────────────────────
let currentUser: any = null;
const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => {
  if (currentUser) req.user = currentUser;
  next();
});
app.use('/api/users', userRoutes);
app.use((err: any, _req: any, res: any, _next: any) => {
  res.status(res.statusCode !== 200 ? res.statusCode : 500).json({ error: err.message });
});

async function makeUser() {
  const u = await User.create({
    email: `u-${new mongoose.Types.ObjectId()}@test.example.com`,
    password: 'hashed_pass',
    isVerified: true,
    name: 'Original Name',
    walletBalance: 5,
    resume: { summary: 'ORIGINAL SUMMARY', skills: ['Go'], experience: [], education: [] },
    preferences: { matchingEnabled: true, remoteOnly: false, minSalary: 0, location: [], jobTypes: [], industries: [], minScore: 30 },
  });
  currentUser = u;
  return u;
}

function snapshot(u: any) {
  const o = u.toObject();
  return JSON.stringify({ name: o.name, resume: o.resume, preferences: o.preferences, walletBalance: o.walletBalance });
}

describe('POST /api/users/cv: unsupported_type route behavior', () => {
  it('returns 400 with the exact body when parseUserCV throws unsupported_type', async () => {
    // catches: 422 instead of 400, wrong message/code/retryable, extra/missing fields
    await makeUser();
    mockParseUserCV.mockRejectedValue(new CvParseError('unsupported_type'));
    const res = await request(app).post('/api/users/cv').attach('file', Buffer.from('whatever'), 'resume.pdf');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      code: 'unsupported_type',
      retryable: false,
      message: 'Please upload a PDF or Word document.',
    });
  });

  it('performs zero user mutation on unsupported_type', async () => {
    // catches: partial write / reset of resume, name, or preferences before or after the failure
    const u = await makeUser();
    const before = snapshot(await User.findById(u._id));
    mockParseUserCV.mockRejectedValue(new CvParseError('unsupported_type'));
    await request(app).post('/api/users/cv').attach('file', Buffer.from('x'), 'resume.pdf');
    const after = snapshot(await User.findById(u._id));
    expect(after).toBe(before);
    expect((await User.findById(u._id))!.resume?.summary).toBe('ORIGINAL SUMMARY');
  });

  it('records an analytics attempt carrying "unsupported_type"', async () => {
    // catches: no analytics call, or wrong outcome/reason string
    await makeUser();
    mockParseUserCV.mockRejectedValue(new CvParseError('unsupported_type'));
    await request(app).post('/api/users/cv').attach('file', Buffer.from('x'), 'resume.pdf');
    expect(mockCaptureAttempt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockCaptureAttempt.mock.calls[0])).toContain('unsupported_type');
  });

  it('does not report unreadable for an unsupported_type failure (and vice versa)', async () => {
    // catches: analytics/response conflating codes
    await makeUser();
    mockParseUserCV.mockRejectedValue(new CvParseError('unsupported_type'));
    const res = await request(app).post('/api/users/cv').attach('file', Buffer.from('x'), 'resume.pdf');
    expect(res.body.code).not.toBe('unreadable');
    expect(JSON.stringify(mockCaptureAttempt.mock.calls[0])).not.toContain('unreadable');
  });

  it('multer does not gate on extension/MIME: resume.bin + image/png reaches parseUserCV (not rejected by multer)', async () => {
    // catches: multer fileFilter still rejecting by extension or mimetype
    await makeUser();
    mockParseUserCV.mockResolvedValue({
      summary: 'Parsed summary text',
      skills: ['TypeScript'],
      experience: [],
      education: [],
    });
    const res = await request(app)
      .post('/api/users/cv')
      .attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'resume.bin', contentType: 'image/png' });
    expect(mockParseUserCV).toHaveBeenCalledTimes(1);
    // parseUserCV's resolved shape is not in the contract, so 200 is not asserted; reaching the parser is the oracle.
    expect(res.body.code).not.toBe('unsupported_type');
  });

  it('a non-PDF/DOCX-looking name and MIME with unsupported content still yields the unsupported_type 400 (not a multer error)', async () => {
    // catches: filter returning its own error/500 before the parser's verdict
    await makeUser();
    mockParseUserCV.mockRejectedValue(new CvParseError('unsupported_type'));
    const res = await request(app)
      .post('/api/users/cv')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'photo.png', contentType: 'image/png' });
    expect(mockParseUserCV).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsupported_type');
  });
});
