import { jobMatcherPrompt } from '../utils/jobMatcherPrompt';

describe('jobMatcherPrompt', () => {
  it('exports a non-empty prompt string', () => {
    expect(typeof jobMatcherPrompt).toBe('string');
    expect(jobMatcherPrompt.trim().length).toBeGreaterThan(0);
  });

  it('constrains verdict to exactly the four allowed labels', () => {
    expect(jobMatcherPrompt).toMatch(/must be exactly one of/i);
    expect(jobMatcherPrompt).toContain('"Strong match"');
    expect(jobMatcherPrompt).toContain('"Mild match"');
    expect(jobMatcherPrompt).toContain('"Weak match"');
    expect(jobMatcherPrompt).toContain('"No match"');
  });

  it('requires reasoning to avoid raw quotes, newlines, and markdown', () => {
    expect(jobMatcherPrompt).toMatch(/no raw double quotes/i);
    expect(jobMatcherPrompt).toMatch(/no newlines/i);
    expect(jobMatcherPrompt).toMatch(/no markdown/i);
  });

  it('requires reasoning to lead with a specific positive signal and end on a recommendation', () => {
    expect(jobMatcherPrompt).toMatch(/positive signal/i);
    expect(jobMatcherPrompt).toMatch(/concrete recommendation/i);
    expect(jobMatcherPrompt).toMatch(/do not invent a weakness/i);
  });

  it('requires weak/no match reasoning to recommend skipping rather than generic encouragement', () => {
    expect(jobMatcherPrompt).toMatch(/skip or "only pursue if\.\.\."/i);
    expect(jobMatcherPrompt).toMatch(/not generic\s+encouragement/i);
  });

  it('keeps the Proxify/Contra platform advisory guidance', () => {
    expect(jobMatcherPrompt).toMatch(/Proxify/);
    expect(jobMatcherPrompt).toMatch(/Contra/);
  });

  // Regression guards: these lock in scoring guidance that must NOT drift.
  // Every user's preferences.minScore was tuned against the current score
  // distribution - changing this prose could silently shift the distribution.
  describe('preserved scoring guidance (must not change)', () => {
    it('keeps the salary floor guidance', () => {
      expect(jobMatcherPrompt).toMatch(/minSalary is their \*minimum\* acceptable salary, not a target/);
      expect(jobMatcherPrompt).toMatch(/Only reduce the score if the job's salary is \*below\* the user's minSalary/);
      expect(jobMatcherPrompt).toMatch(/If salary is not specified in the job listing, do not penalize the match/);
    });

    it('keeps the learned preferences emphasis', () => {
      expect(jobMatcherPrompt).toMatch(/Pay close attention to the user's "Learned Preferences"/);
      expect(jobMatcherPrompt).toMatch(/reduce the score significantly/);
    });

    it('keeps the remote compatibility and currentLocation handling', () => {
      expect(jobMatcherPrompt).toMatch(/Carefully evaluate remote compatibility/);
      expect(jobMatcherPrompt).toMatch(/treat this as region-restricted remote/);
      expect(jobMatcherPrompt).toMatch(
        /currentLocation tells you where the user \*lives\*, not what regions they want to work in, and not a filter for remote roles/
      );
      expect(jobMatcherPrompt).toMatch(/A user based in India can and should be matched to global remote roles/);
    });

    it('keeps the location/industry/requirements conflict guidance', () => {
      expect(jobMatcherPrompt).toMatch(
        /If the job location, industry, or requirements clearly conflict with the user's preferences or experience, reduce the score/
      );
    });

    it('keeps the "do not refer to the user as the candidate" instruction', () => {
      expect(jobMatcherPrompt).toMatch(/Do not refer to the user as "the candidate" or by name/);
    });

    it('keeps the final JSON-only instruction', () => {
      expect(jobMatcherPrompt.trim().endsWith('Only respond with a valid JSON object. No markdown, no extra text.')).toBe(true);
    });
  });
});
