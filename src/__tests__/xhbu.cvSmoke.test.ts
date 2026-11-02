// Smoke tests for xhbu: parser failure classification + real multer filter/error mapping.
process.env.OPENAI_API_KEY = 'test-key';

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
}));

jest.mock('pdf-parse', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../services/analyticsService', () => ({
  captureCvUploadAttempt: jest.fn(),
  captureLifecycleEvent: jest.fn(),
}));

import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import pdfParse from 'pdf-parse';
import { parseUserCV, CvParseError } from '../services/userService';
import upload from '../middleware/fileUpload';
import { cvUploadErrorHandler } from '../middleware/cvUploadErrors';

const mockPdfParse = pdfParse as unknown as jest.Mock;
const tmpPath = path.join(os.tmpdir(), `xhbu-smoke-${process.pid}.pdf`);

beforeEach(() => {
  mockCreate.mockReset();
  mockPdfParse.mockReset();
  fs.writeFileSync(tmpPath, Buffer.from('%PDF-1.4 fake'));
});
afterAll(() => {
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
});

describe('parseUserCV failure classification', () => {
  it('throws unreadable for short text without calling OpenAI', async () => {
    mockPdfParse.mockResolvedValue({ text: 'too short' });
    await expect(parseUserCV(tmpPath)).rejects.toMatchObject({ code: 'unreadable' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('throws transient after one retry on persistent 429', async () => {
    mockPdfParse.mockResolvedValue({ text: 'x'.repeat(300) });
    mockCreate.mockRejectedValue(Object.assign(new Error('rate'), { status: 429 }));
    const err = await parseUserCV(tmpPath).catch((e) => e);
    expect(err).toBeInstanceOf(CvParseError);
    expect(err.code).toBe('transient');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('throws invalid_output for JSON with no meaningful resume', async () => {
    mockPdfParse.mockResolvedValue({ text: 'x'.repeat(300) });
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ name: 'A', resume: { certifications: ['AWS'] } }) } }],
    });
    await expect(parseUserCV(tmpPath)).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

describe('parseUserCV content gate (magic bytes)', () => {
  it('throws unsupported_type for bytes that are neither PDF nor DOCX, even with a .pdf extension', async () => {
    fs.writeFileSync(tmpPath, Buffer.from('hello, not a document'));
    await expect(parseUserCV(tmpPath)).rejects.toMatchObject({ code: 'unsupported_type' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('real multer filter + error mapping', () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { id: 'u1' };
    next();
  });
  app.post('/cv', upload.single('file'), cvUploadErrorHandler, (_req: express.Request, res: express.Response) => {
    res.status(200).json({ ok: true });
  });

  it('accepts a .pdf sent as application/octet-stream', async () => {
    const res = await request(app)
      .post('/cv')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'cv.pdf', contentType: 'application/octet-stream' });
    expect(res.status).toBe(200);
  });

  it('filter no longer gates on type: a real PDF named .bin with image/png reaches the handler', async () => {
    const res = await request(app)
      .post('/cv')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'resume.bin', contentType: 'image/png' });
    expect(res.status).toBe(200);
  });

  it('rejects an oversized file with 413', async () => {
    const res = await request(app)
      .post('/cv')
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1024), { filename: 'big.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('too_large');
  });
});
