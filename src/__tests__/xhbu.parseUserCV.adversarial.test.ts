// Phase 2b adversarial tests for parseUserCV (oracle = task contract, not implementation).
// Real parseUserCV; mocked: pdf-parse, mammoth, openai.

const mockCreate = jest.fn();
const mockPdfParse: any = jest.fn();
mockPdfParse.__esModule = true;
mockPdfParse.default = mockPdfParse;
const mockExtractRawText = jest.fn();

jest.mock('openai', () => {
  const ctor: any = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: (...a: any[]) => mockCreate(...a) } },
  }));
  ctor.__esModule = true;
  ctor.default = ctor;
  return ctor;
});
jest.mock('pdf-parse', () => mockPdfParse);
jest.mock('mammoth', () => ({
  __esModule: true,
  default: { extractRawText: (...a: any[]) => mockExtractRawText(...a) },
  extractRawText: (...a: any[]) => mockExtractRawText(...a),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseUserCV, CvParseError, MIN_RESUME_TEXT_CHARS } from '../services/userService';
import { hasMeaningfulResume } from '../utils/resumePredicate';

jest.setTimeout(60000);

const LONG_TEXT = 'Senior software engineer with ten years of experience building distributed systems. '.repeat(5); // > 200
const goodModelJson = {
  name: 'Jane Doe',
  resume: {
    summary: 'Seasoned engineer',
    skills: ['TypeScript', 'Node'],
    experience: ['Acme - Lead'],
    education: ['BSc CS'],
  },
  preferences: { jobTypes: ['full-time'], location: ['Remote'], remoteOnly: true, minSalary: 0, industries: [] },
};
const completion = (content: string | null) => ({ choices: [{ message: { content } }] });
const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

let tmpDir: string;
let pdfPath: string;
let docxPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhbu-'));
  pdfPath = path.join(tmpDir, 'cv.pdf');
  docxPath = path.join(tmpDir, 'cv.docx');
  fs.writeFileSync(pdfPath, '%PDF-1.4 dummy');
  fs.writeFileSync(docxPath, 'PK dummy');
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  mockCreate.mockReset();
  mockPdfParse.mockReset();
  mockExtractRawText.mockReset();
  process.env.OPENAI_API_KEY = 'test-key';
  mockPdfParse.mockResolvedValue({ text: LONG_TEXT });
  mockExtractRawText.mockResolvedValue({ value: LONG_TEXT });
});

const expectCvError = async (p: Promise<any>, code: string) => {
  let err: any;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeDefined();
  expect(err).toBeInstanceOf(CvParseError);
  expect(err.name).toBe('CvParseError');
  expect(err.code).toBe(code);
};

describe('constants / success', () => {
  it('MIN_RESUME_TEXT_CHARS is 200', () => {
    expect(MIN_RESUME_TEXT_CHARS).toBe(200);
  });

  it('PDF success returns {name,resume,preferences} with a meaningful resume (catches returning raw/empty shapes)', async () => {
    mockCreate.mockResolvedValue(completion(JSON.stringify(goodModelJson)));
    const out = await parseUserCV(pdfPath);
    expect(out.name).toBe('Jane Doe');
    expect(hasMeaningfulResume(out.resume)).toBe(true);
    expect(out.preferences).toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('DOCX success path works too (catches docx branch broken)', async () => {
    mockCreate.mockResolvedValue(completion(JSON.stringify(goodModelJson)));
    const out = await parseUserCV(docxPath);
    expect(hasMeaningfulResume(out.resume)).toBe(true);
  });
});

describe('unreadable text gate', () => {
  it('199 trimmed chars => unreadable, OpenAI never called (off-by-one on threshold)', async () => {
    mockPdfParse.mockResolvedValue({ text: 'a'.repeat(199) });
    await expectCvError(parseUserCV(pdfPath), 'unreadable');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('exactly 200 trimmed chars is accepted (boundary: < not <=)', async () => {
    mockPdfParse.mockResolvedValue({ text: 'a'.repeat(200) });
    mockCreate.mockResolvedValue(completion(JSON.stringify(goodModelJson)));
    const out = await parseUserCV(pdfPath);
    expect(hasMeaningfulResume(out.resume)).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('length is measured AFTER trim: 150 chars padded with whitespace to 500 => unreadable (catches untrimmed length)', async () => {
    mockPdfParse.mockResolvedValue({ text: ' '.repeat(175) + 'a'.repeat(150) + ' \n\t'.repeat(60) });
    await expectCvError(parseUserCV(pdfPath), 'unreadable');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('empty extracted text => unreadable (DOCX too)', async () => {
    mockExtractRawText.mockResolvedValue({ value: '' });
    await expectCvError(parseUserCV(docxPath), 'unreadable');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('transient retry policy', () => {
  it.each([429, 500, 502, 503, 599])('persistent HTTP %i => exactly 2 calls then transient', async (status) => {
    mockCreate.mockRejectedValue(httpErr(status));
    await expectCvError(parseUserCV(pdfPath), 'transient');
    expect(mockCreate).toHaveBeenCalledTimes(2); // catches no-retry, retry-forever, retry x2
  });

  it('429 then success => returns result, exactly 2 calls', async () => {
    mockCreate
      .mockRejectedValueOnce(httpErr(429))
      .mockResolvedValueOnce(completion(JSON.stringify(goodModelJson)));
    const out = await parseUserCV(pdfPath);
    expect(hasMeaningfulResume(out.resume)).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('connection error then timeout error => 2 calls then transient', async () => {
    mockCreate
      .mockRejectedValueOnce(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }))
      .mockRejectedValueOnce(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
    await expectCvError(parseUserCV(pdfPath), 'transient');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 422])('non-transient HTTP %i => NOT retried (1 call)', async (status) => {
    mockCreate.mockRejectedValue(httpErr(status));
    let err: any;
    try { await parseUserCV(pdfPath); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(1); // catches over-eager retry (e.g. retry on any error)
  });

  it('non-transient failure on 2nd attempt after transient 1st => stops at 2 calls, not mislabelled success', async () => {
    mockCreate.mockRejectedValueOnce(httpErr(503)).mockRejectedValueOnce(httpErr(401));
    let err: any;
    try { await parseUserCV(pdfPath); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe('invalid model output', () => {
  it.each([
    ['null content', null],
    ['empty string', ''],
    ['whitespace', '   \n '],
    ['no JSON object', 'Sorry, I cannot parse this resume.'],
    ['unparseable JSON', '{"name": "Jane", "resume": {summary: oops'],
  ])('%s => invalid_output, no retry', async (_l, content) => {
    mockCreate.mockResolvedValue(completion(content as any));
    await expectCvError(parseUserCV(pdfPath), 'invalid_output');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('resume with only certifications/languages/projects/etc => invalid_output (the non-meaningful guard)', async () => {
    mockCreate.mockResolvedValue(completion(JSON.stringify({
      name: 'Jane',
      resume: {
        summary: '   ', skills: [], experience: [''], education: ['  '],
        certifications: ['AWS'], languages: ['English'], projects: ['Proj'],
        achievements: ['Won'], volunteerExperience: ['Food bank'], interests: ['Chess'],
      },
      preferences: {},
    })));
    await expectCvError(parseUserCV(pdfPath), 'invalid_output');
  });

  it('entirely empty resume object => invalid_output', async () => {
    mockCreate.mockResolvedValue(completion(JSON.stringify({ name: 'x', resume: {}, preferences: {} })));
    await expectCvError(parseUserCV(pdfPath), 'invalid_output');
  });

  it('missing resume key => invalid_output', async () => {
    mockCreate.mockResolvedValue(completion(JSON.stringify({ name: 'x', preferences: {} })));
    await expectCvError(parseUserCV(pdfPath), 'invalid_output');
  });

  it('resume = string (not object) => invalid_output', async () => {
    mockCreate.mockResolvedValue(completion(JSON.stringify({ name: 'x', resume: 'lots of text', preferences: {} })));
    await expectCvError(parseUserCV(pdfPath), 'invalid_output');
  });

  it('experience as {text} object is meaningful => success', async () => {
    mockCreate.mockResolvedValue(completion(JSON.stringify({
      name: 'x', resume: { experience: [{ text: 'Built things' }] }, preferences: {},
    })));
    const out = await parseUserCV(pdfPath);
    expect(hasMeaningfulResume(out.resume)).toBe(true);
  });

  it('experience as {text:"  "} only => invalid_output', async () => {
    mockCreate.mockResolvedValue(completion(JSON.stringify({
      name: 'x', resume: { experience: [{ text: '  ' }, { link: 'http://x' }] }, preferences: {},
    })));
    await expectCvError(parseUserCV(pdfPath), 'invalid_output');
  });

  it('summary alone is meaningful => success', async () => {
    mockCreate.mockResolvedValue(completion(JSON.stringify({ name: 'x', resume: { summary: 'Engineer' }, preferences: {} })));
    const out = await parseUserCV(pdfPath);
    expect(out.resume.summary).toBe('Engineer');
  });
});

describe('configuration', () => {
  it('missing OPENAI_API_KEY => plain Error, NOT CvParseError', async () => {
    delete process.env.OPENAI_API_KEY;
    let err: any;
    try { await parseUserCV(pdfPath); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CvParseError);
    expect(err.name).not.toBe('CvParseError');
  });
});
