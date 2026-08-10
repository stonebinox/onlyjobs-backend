// CONTRACT: parseUserCV must read the file and return parsed data, but must NOT delete the file.
// Responsibility for temp-file cleanup was moved to the controller (le8). This test enforces
// that a future developer cannot reintroduce `fs.unlink` inside the parser without breaking it.
//
// APPROACH: use a real temp file + real fs; mock only the parse libraries and OpenAI so the
// success path is deterministic without a real PDF or API key.

jest.mock('pdf-parse', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({ text: 'John Doe, Senior Engineer, TypeScript' }),
}));

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  name: 'John Doe',
                  resume: {
                    skills: ['TypeScript'],
                    summary: 'Senior Engineer',
                    experience: [],
                    education: [],
                    certifications: [],
                    languages: [],
                    projects: [],
                    achievements: [],
                    volunteerExperience: [],
                    interests: [],
                  },
                  preferences: {
                    jobTypes: ['full_time'],
                    location: ['Remote'],
                    remoteOnly: true,
                    minSalary: 50000,
                    industries: ['Tech'],
                  },
                }),
              },
            },
          ],
        }),
      },
    },
  }),
}));

import os from 'os';
import path from 'path';
import fs from 'fs';
import { parseUserCV } from '../services/userService';

const tmpPath = path.join(os.tmpdir(), `le8-parser-contract-${process.pid}.pdf`);

afterAll(() => {
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
});

describe('parseUserCV — parser-does-not-delete contract (le8)', () => {
  it('returns parsed data AND leaves the file on disk — parser must not unlink', async () => {
    fs.writeFileSync(tmpPath, Buffer.from('%PDF fake'));

    const result = await parseUserCV(tmpPath);

    // Success path was reached
    expect(result).toBeTruthy();
    // THE CONTRACT: parser did not delete the file.
    // A reintroduced `fs.unlink(uploadedFilePath)` inside parseUserCV would make this fail.
    expect(fs.existsSync(tmpPath)).toBe(true);
  });
});
