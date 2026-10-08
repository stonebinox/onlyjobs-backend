import { capNewJobsByCompany, COMPANY_CAP_K } from '../utils/capNewJobsByCompany';

function makeJob(
  id: string,
  company: string,
  postedDate?: Date
): { _id: string; company: string; postedDate?: Date } {
  return { _id: id, company, postedDate };
}

const DAY = 86400000;
const BASE = new Date('2026-01-10T00:00:00Z').getTime();

describe('COMPANY_CAP_K', () => {
  it('is 3', () => {
    expect(COMPANY_CAP_K).toBe(3);
  });
});

describe('capNewJobsByCompany — basic cap', () => {
  it('keeps 3 newest when 4 same-company jobs are present', () => {
    const jobs = [
      makeJob('id1', 'Acme', new Date(BASE + 3 * DAY)), // newest
      makeJob('id2', 'Acme', new Date(BASE + 2 * DAY)),
      makeJob('id3', 'Acme', new Date(BASE + 1 * DAY)),
      makeJob('id4', 'Acme', new Date(BASE)),            // oldest — should be dropped
    ];
    const result = capNewJobsByCompany(jobs, 3);
    expect(result).toHaveLength(3);
    const ids = result.map((j) => j._id);
    expect(ids).toContain('id1');
    expect(ids).toContain('id2');
    expect(ids).toContain('id3');
    expect(ids).not.toContain('id4');
  });

  it('returns all jobs when company count <= K', () => {
    const jobs = [
      makeJob('id1', 'Acme', new Date(BASE + 2 * DAY)),
      makeJob('id2', 'Acme', new Date(BASE + 1 * DAY)),
      makeJob('id3', 'Acme', new Date(BASE)),
    ];
    const result = capNewJobsByCompany(jobs, 3);
    expect(result).toHaveLength(3);
  });
});

describe('capNewJobsByCompany — mixed pool', () => {
  it('caps only the over-represented company; under-K companies keep all', () => {
    const jobs = [
      makeJob('acme1', 'Acme Corp', new Date(BASE + 4 * DAY)),
      makeJob('acme2', 'Acme Corp', new Date(BASE + 3 * DAY)),
      makeJob('acme3', 'Acme Corp', new Date(BASE + 2 * DAY)),
      makeJob('acme4', 'Acme Corp', new Date(BASE + 1 * DAY)), // capped
      makeJob('beta1', 'Beta Ltd', new Date(BASE + 5 * DAY)),
      makeJob('beta2', 'Beta Ltd', new Date(BASE)),
    ];
    const result = capNewJobsByCompany(jobs, 3);
    expect(result).toHaveLength(5); // 3 Acme + 2 Beta
    const ids = result.map((j) => j._id);
    expect(ids).not.toContain('acme4');
    expect(ids).toContain('beta1');
    expect(ids).toContain('beta2');
  });
});

describe('capNewJobsByCompany — blank companies (bucketed under K per Grok disposition #2)', () => {
  it('blank/empty company names share ONE bucket, capped at K (N=5, K=3 -> 3 retained, newest kept)', () => {
    const jobs = [
      makeJob('b1', '', new Date(BASE + 4 * DAY)), // newest
      makeJob('b2', '', new Date(BASE + 3 * DAY)),
      makeJob('b3', '', new Date(BASE + 2 * DAY)),
      makeJob('b4', '', new Date(BASE + 1 * DAY)), // dropped
      makeJob('b5', '', new Date(BASE)),            // dropped
    ];
    const result = capNewJobsByCompany(jobs, 3);
    // Blanks share one bucket capped at K; 2 oldest are evicted
    expect(result).toHaveLength(3);
    const ids = result.map((j) => j._id);
    expect(ids).toContain('b1');
    expect(ids).toContain('b2');
    expect(ids).toContain('b3');
    expect(ids).not.toContain('b4');
    expect(ids).not.toContain('b5');
  });

  it("whitespace-only company ('   ') is treated as blank and bucketed under K (N=5 -> 3)", () => {
    const jobs = [
      makeJob('ws0', '   ', new Date(BASE + 4 * DAY)), // newest
      makeJob('ws1', '   ', new Date(BASE + 3 * DAY)),
      makeJob('ws2', '   ', new Date(BASE + 2 * DAY)),
      makeJob('ws3', '   ', new Date(BASE + 1 * DAY)), // dropped
      makeJob('ws4', '   ', new Date(BASE)),            // dropped
    ];
    const result = capNewJobsByCompany(jobs, 3);
    expect(result).toHaveLength(3);
    const ids = result.map((j) => j._id);
    expect(ids).toContain('ws0');
    expect(ids).toContain('ws1');
    expect(ids).toContain('ws2');
    expect(ids).not.toContain('ws3');
    expect(ids).not.toContain('ws4');
  });

  it('mixed: 5 blank + 5 of one named company, K=3 -> 3 blanks + 3 named = 6 total', () => {
    const blankJobs = [
      makeJob('blank0', '', new Date(BASE + 4 * DAY)), // newest blank
      makeJob('blank1', '', new Date(BASE + 3 * DAY)),
      makeJob('blank2', '', new Date(BASE + 2 * DAY)),
      makeJob('blank3', '', new Date(BASE + 1 * DAY)), // dropped
      makeJob('blank4', '', new Date(BASE)),            // dropped
    ];
    const namedJobs = [
      makeJob('named0', 'NamedCo', new Date(BASE + 9 * DAY)), // newest named
      makeJob('named1', 'NamedCo', new Date(BASE + 8 * DAY)),
      makeJob('named2', 'NamedCo', new Date(BASE + 7 * DAY)),
      makeJob('named3', 'NamedCo', new Date(BASE + 6 * DAY)), // dropped
      makeJob('named4', 'NamedCo', new Date(BASE + 5 * DAY)), // dropped
    ];
    const result = capNewJobsByCompany([...blankJobs, ...namedJobs], 3);
    expect(result).toHaveLength(6);
    // Each bucket contributes exactly 3 newest; assert per-bucket counts, not just total
    const retainedBlanks = result.filter((j) => j.company.trim() === '');
    const retainedNamed = result.filter((j) => j.company === 'NamedCo');
    expect(retainedBlanks).toHaveLength(3);
    expect(retainedNamed).toHaveLength(3);
  });
});

describe('capNewJobsByCompany — _id tiebreak', () => {
  it('uses _id DESC tiebreak when postedDate values are equal', () => {
    const sameDate = new Date(BASE);
    const jobs = [
      makeJob('aaa', 'Acme', sameDate),
      makeJob('aab', 'Acme', sameDate),
      makeJob('aac', 'Acme', sameDate),
      makeJob('aad', 'Acme', sameDate), // newest _id
    ];
    const result = capNewJobsByCompany(jobs, 3);
    expect(result).toHaveLength(3);
    // Kept: aad, aac, aab (top 3 by _id DESC); aaa is dropped
    expect(result.map((j) => j._id)).not.toContain('aaa');
  });
});

describe('capNewJobsByCompany — missing/invalid postedDate sentinel', () => {
  it('places jobs with missing postedDate last (sentinel sorts last)', () => {
    const jobs = [
      makeJob('has_date', 'Acme', new Date(BASE)),
      makeJob('no_date', 'Acme', undefined), // sentinel → sorts last → dropped when cap=1
    ];
    const result = capNewJobsByCompany(jobs, 1);
    expect(result).toHaveLength(1);
    expect(result[0]._id).toBe('has_date');
  });

  it('places jobs with invalid Date last', () => {
    const jobs = [
      makeJob('good', 'Acme', new Date(BASE)),
      makeJob('bad', 'Acme', new Date('not-a-date')), // NaN → sentinel
    ];
    const result = capNewJobsByCompany(jobs, 1);
    expect(result[0]._id).toBe('good');
  });
});

describe('capNewJobsByCompany — determinism', () => {
  it('same kept ids AND same global order under shuffled input', () => {
    const jobs = [
      makeJob('id1', 'Acme', new Date(BASE + 3 * DAY)),
      makeJob('id2', 'Acme', new Date(BASE + 2 * DAY)),
      makeJob('id3', 'Acme', new Date(BASE + 1 * DAY)),
      makeJob('id4', 'Acme', new Date(BASE)),
      makeJob('id5', 'Beta', new Date(BASE + 4 * DAY)),
    ];
    const shuffled = [jobs[3], jobs[0], jobs[4], jobs[2], jobs[1]];

    const r1 = capNewJobsByCompany(jobs, 3);
    const r2 = capNewJobsByCompany(shuffled, 3);

    expect(r1.map((j) => j._id)).toEqual(r2.map((j) => j._id));
  });
});

describe('capNewJobsByCompany — global output order', () => {
  it('retained jobs are in global sorted order (postedDate DESC, _id DESC)', () => {
    const jobs = [
      makeJob('id1', 'Acme', new Date(BASE + 3 * DAY)),
      makeJob('id2', 'Acme', new Date(BASE + 2 * DAY)),
      makeJob('id3', 'Acme', new Date(BASE + 1 * DAY)),
      makeJob('id4', 'Beta', new Date(BASE + 2 * DAY + 500)), // between Acme id1 and id2 by date
    ];
    const result = capNewJobsByCompany(jobs, 3);
    // Expected global order: id1 (newest Acme), id4 (Beta, slightly newer than Acme id2), id2, id3
    expect(result.map((j) => j._id)).toEqual(['id1', 'id4', 'id2', 'id3']);
  });
});

describe('capNewJobsByCompany — default k parameter', () => {
  it('defaults k to COMPANY_CAP_K (3) when the second argument is omitted', () => {
    // 5 same-company jobs, distinct descending dates; omitting k must cap at COMPANY_CAP_K (3)
    const jobs = [
      makeJob('d1', 'Acme', new Date(BASE + 4 * DAY)), // newest
      makeJob('d2', 'Acme', new Date(BASE + 3 * DAY)),
      makeJob('d3', 'Acme', new Date(BASE + 2 * DAY)),
      makeJob('d4', 'Acme', new Date(BASE + 1 * DAY)), // dropped
      makeJob('d5', 'Acme', new Date(BASE)),            // dropped
    ];
    const withDefault = capNewJobsByCompany(jobs);
    const withExplicit = capNewJobsByCompany(jobs, 3);
    expect(withDefault).toHaveLength(COMPANY_CAP_K); // 3, not 0, not 5
    expect(withDefault.map((j) => j._id)).toEqual(withExplicit.map((j) => j._id));
  });
});
