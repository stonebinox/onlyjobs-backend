/**
 * xhbu Group 2 - extractor dispatch by MAGIC BYTES, not filename extension.
 *
 * CONTRACT: parseUserCV picks the extractor from the file's leading bytes:
 *   `%PDF` -> pdf-parse;  `PK` (0x50 0x4B) -> mammoth - REGARDLESS of filename extension.
 *
 * MUTATION CAUGHT: dispatching on path.extname()/filename. With (a) a "%PDF" body named
 * resume.docx, an extension-based impl would call mammoth; with (b) a "PK" body named
 * resume.pdf it would call pdf-parse. Both assertions below fail on that mutation.
 */
const RESUME_TEXT =
  'Jane Doe Senior Backend Engineer. Ten years building distributed systems in TypeScript and Go. ' +
  'Led platform team at Acme Corp, scaled ingestion to one billion events per day, mentored engineers. ' +
  'Education: BSc Computer Science. Skills: TypeScript, Node.js, PostgreSQL, Kubernetes, AWS.';

const RESUME_JSON = JSON.stringify({
  name: 'Jane Doe',
  resume: {
    summary: 'Senior backend engineer',
    skills: ['TypeScript', 'Node.js'],
    experience: [{ text: 'Led platform team at Acme Corp' }],
    education: [{ text: 'BSc Computer Science' }],
  },
  preferences: {},
});

const mockPdfParse = jest.fn();
const mockExtractRawText = jest.fn();
const mockConvertToHtml = jest.fn();
const mockCreate = jest.fn();

jest.mock('pdf-parse', () => {
  const fn: any = (...a: any[]) => mockPdfParse(...a);
  fn.default = fn;
  return fn;
});

jest.mock('mammoth', () => {
  const m: any = {
    extractRawText: (...a: any[]) => mockExtractRawText(...a),
    convertToHtml: (...a: any[]) => mockConvertToHtml(...a),
  };
  m.default = m;
  return m;
});

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: (...a: any[]) => mockCreate(...a) } },
    audio: { transcriptions: { create: jest.fn() } },
  })),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseUserCV } from '../services/userService';

const filler = ' lorem ipsum dolor sit amet consectetur'.repeat(20); // >> 200 non-whitespace chars
let dir: string;

beforeAll(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhbu-magic-'));
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  mockPdfParse.mockReset().mockResolvedValue({ text: RESUME_TEXT });
  mockExtractRawText.mockReset().mockResolvedValue({ value: RESUME_TEXT });
  mockConvertToHtml.mockReset().mockResolvedValue({ value: `<p>${RESUME_TEXT}</p>` });
  mockCreate.mockReset().mockResolvedValue({
    choices: [{ message: { content: RESUME_JSON } }],
  });
});

describe('xhbu: parseUserCV dispatches by magic bytes, not extension', () => {
  it('(a) %PDF bytes named resume.docx -> pdf-parse runs, mammoth does not', async () => {
    const p = path.join(dir, 'resume.docx');
    fs.writeFileSync(p, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(filler)]));
    const out = await parseUserCV(p);
    expect(out).toBeTruthy();
    expect(mockPdfParse).toHaveBeenCalled();
    expect(mockExtractRawText).not.toHaveBeenCalled();
    expect(mockConvertToHtml).not.toHaveBeenCalled();
  });

  it('(b) PK bytes named resume.pdf -> mammoth runs, pdf-parse does not', async () => {
    const p = path.join(dir, 'resume.pdf');
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(filler)]));
    const out = await parseUserCV(p);
    expect(out).toBeTruthy();
    expect(mockExtractRawText.mock.calls.length + mockConvertToHtml.mock.calls.length).toBeGreaterThan(0);
    expect(mockPdfParse).not.toHaveBeenCalled();
  });
});
