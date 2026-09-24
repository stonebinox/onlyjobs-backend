import {
  normalizeCompanyName,
  buildCompanyHistoryMap,
  applyCompanyHistoryNudge,
  composeReasoningWithHistory,
  CompanyOutcomeCounts,
} from '../utils/companyHistory';

// ---------------------------------------------------------------------------
// normalizeCompanyName
// ---------------------------------------------------------------------------

describe('normalizeCompanyName', () => {
  it('lowercases and trims', () => {
    expect(normalizeCompanyName('  ACME  ')).toBe('acme');
  });

  it('strips trailing Inc.', () => {
    expect(normalizeCompanyName('Acme Inc.')).toBe('acme');
  });

  it('strips trailing Corp', () => {
    expect(normalizeCompanyName('ACME Corp')).toBe('acme');
  });

  it('strips trailing ", Inc."', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
  });

  it('strips trailing LLC', () => {
    expect(normalizeCompanyName('Acme LLC')).toBe('acme');
  });

  it('strips trailing Ltd.', () => {
    expect(normalizeCompanyName('Acme Ltd.')).toBe('acme');
  });

  it('strips trailing GmbH', () => {
    expect(normalizeCompanyName('Acme GmbH')).toBe('acme');
  });

  it('strips trailing LLP', () => {
    expect(normalizeCompanyName('Acme LLP')).toBe('acme');
  });

  it('makes Acme, Acme Inc., and ACME Corp normalize to the same key', () => {
    const a = normalizeCompanyName('Acme');
    const b = normalizeCompanyName('Acme Inc.');
    const c = normalizeCompanyName('ACME Corp');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('does NOT match Acme to Acme Health (no substring/fuzzy)', () => {
    expect(normalizeCompanyName('Acme')).not.toBe(normalizeCompanyName('Acme Health'));
  });

  it('normalizes Unicode diacritics', () => {
    expect(normalizeCompanyName('Ácme')).toBe('acme');
  });

  it('removes punctuation after suffix strip', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeCompanyName('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildCompanyHistoryMap
// ---------------------------------------------------------------------------

describe('buildCompanyHistoryMap', () => {
  it('aggregates multiple outcomes for the same company', () => {
    const records = [
      { applicationOutcome: 'rejected', company: 'Acme Inc.' },
      { applicationOutcome: 'rejected', company: 'ACME Corp' },
      { applicationOutcome: 'interview', company: 'Acme' },
    ];
    const map = buildCompanyHistoryMap(records);
    const counts = map.get('acme');
    expect(counts).toBeDefined();
    expect(counts!.rejected).toBe(2);
    expect(counts!.interview).toBe(1);
    expect(counts!.heard_back).toBe(0);
  });

  it('skips records with missing or invalid outcome', () => {
    const records = [
      { applicationOutcome: null, company: 'Acme' },
      { applicationOutcome: undefined, company: 'Acme' },
      { applicationOutcome: 'invalid_outcome', company: 'Acme' },
      { applicationOutcome: 'offer', company: 'Acme' },
    ];
    const map = buildCompanyHistoryMap(records);
    const counts = map.get('acme');
    expect(counts).toBeDefined();
    expect(counts!.offer).toBe(1);
    expect(counts!.heard_back + counts!.no_response + counts!.rejected + counts!.interview).toBe(0);
  });

  it('skips records with blank company', () => {
    const records = [{ applicationOutcome: 'offer', company: '' }];
    const map = buildCompanyHistoryMap(records);
    expect(map.size).toBe(0);
  });

  it('skips records whose JobListing was deleted (company key missing)', () => {
    const records = [
      { applicationOutcome: 'rejected', company: 'ExistingCo' },
    ];
    const map = buildCompanyHistoryMap(records);
    expect(map.get('existingco')).toBeDefined();
    // A record with no company (simulating deleted job) is skipped
    const withDeleted = [
      { applicationOutcome: 'rejected', company: 'ExistingCo' },
      { applicationOutcome: 'interview', company: '' },
    ];
    const map2 = buildCompanyHistoryMap(withDeleted);
    expect(map2.get('existingco')!.rejected).toBe(1);
    expect(map2.get('existingco')!.interview).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyCompanyHistoryNudge
// ---------------------------------------------------------------------------

const noHistory: CompanyOutcomeCounts = {
  heard_back: 0, no_response: 0, rejected: 0, interview: 0, offer: 0,
};

describe('applyCompanyHistoryNudge — no history', () => {
  it('returns baseScore unchanged when history is undefined', () => {
    const { adjustedScore, reasoningLine } = applyCompanyHistoryNudge(50, 30, undefined);
    expect(adjustedScore).toBe(50);
    expect(reasoningLine).toBeNull();
  });

  it('returns baseScore unchanged when all counts are 0', () => {
    const { adjustedScore, reasoningLine } = applyCompanyHistoryNudge(50, 30, noHistory);
    expect(adjustedScore).toBe(50);
    expect(reasoningLine).toBeNull();
  });
});

describe('applyCompanyHistoryNudge — positive outcomes', () => {
  it('adds +3 for one interview', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, interview: 1 };
    const { adjustedScore } = applyCompanyHistoryNudge(50, 30, history);
    expect(adjustedScore).toBe(53);
  });

  it('adds +4 for one offer', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, offer: 1 };
    const { adjustedScore } = applyCompanyHistoryNudge(50, 30, history);
    expect(adjustedScore).toBe(54);
  });

  it('adds +1 for one heard_back', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, heard_back: 1 };
    const { adjustedScore } = applyCompanyHistoryNudge(50, 30, history);
    expect(adjustedScore).toBe(51);
  });

  it('clamps total nudge to +5 for large positive history', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, offer: 3, interview: 2 };
    const { adjustedScore } = applyCompanyHistoryNudge(50, 30, history);
    // Raw nudge = 3*4 + 2*3 = 18 → clamped to 5
    expect(adjustedScore).toBe(55);
  });
});

describe('applyCompanyHistoryNudge — negative outcomes', () => {
  it('subtracts 3 for one rejection', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, rejected: 1 };
    const { adjustedScore } = applyCompanyHistoryNudge(50, 30, history);
    expect(adjustedScore).toBe(47);
  });

  it('subtracts 1 for one no_response', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, no_response: 1 };
    const { adjustedScore } = applyCompanyHistoryNudge(50, 30, history);
    expect(adjustedScore).toBe(49);
  });

  it('caps no_response aggregate at -2 (three ghosts still only -2)', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, no_response: 3 };
    // Raw = 3 * -1 = -3, but floor at -2
    const { adjustedScore } = applyCompanyHistoryNudge(50, 30, history);
    expect(adjustedScore).toBe(48);
  });

  it('clamps total nudge to -5 for large negative history', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, rejected: 5 };
    // Raw nudge = 5*-3 = -15 → clamped to -5
    const { adjustedScore } = applyCompanyHistoryNudge(50, 30, history);
    expect(adjustedScore).toBe(45);
  });
});

describe('applyCompanyHistoryNudge — gate invariant', () => {
  it('applies no nudge when nudge would flip score from below to above minScore', () => {
    // base=28, minScore=30, interview nudge +3 would push to 31 (above gate) → no nudge
    const history: CompanyOutcomeCounts = { ...noHistory, interview: 1 };
    const { adjustedScore, reasoningLine } = applyCompanyHistoryNudge(28, 30, history);
    expect(adjustedScore).toBe(28);
    expect(reasoningLine).not.toBeNull(); // reasoning line still added
  });

  it('applies no nudge when nudge would flip score from above to below minScore', () => {
    // base=32, minScore=30, rejection nudge -3 would push to 29 (below gate) → no nudge
    const history: CompanyOutcomeCounts = { ...noHistory, rejected: 1 };
    const { adjustedScore, reasoningLine } = applyCompanyHistoryNudge(32, 30, history);
    expect(adjustedScore).toBe(32);
    expect(reasoningLine).not.toBeNull();
  });

  it('applies nudge normally when base is well above minScore and nudge does not cross', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, rejected: 1 };
    // base=50, minScore=30, nudge=-3 → 47 (still above 30)
    const { adjustedScore } = applyCompanyHistoryNudge(50, 30, history);
    expect(adjustedScore).toBe(47);
  });

  it('applies nudge normally when base is well below minScore and nudge does not cross', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, interview: 1 };
    // base=20, minScore=30, nudge=+3 → 23 (still below 30)
    const { adjustedScore } = applyCompanyHistoryNudge(20, 30, history);
    expect(adjustedScore).toBe(23);
  });

  it('handles minScore=0: nudge always applies since base is always >= 0', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, interview: 1 };
    const { adjustedScore } = applyCompanyHistoryNudge(5, 0, history);
    expect(adjustedScore).toBe(8);
  });

  it('handles minScore=100: below-gate nudge from rejected score applies', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, rejected: 1 };
    // base=95, minScore=100 → base is below gate, nudge=-3 → 92, still below gate → apply
    const { adjustedScore } = applyCompanyHistoryNudge(95, 100, history);
    expect(adjustedScore).toBe(92);
  });
});

describe('applyCompanyHistoryNudge — score clamping to 0..100', () => {
  it('does not push score below 0', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, rejected: 5 };
    const { adjustedScore } = applyCompanyHistoryNudge(3, 0, history);
    // nudge = -5 (clamped), 3 + -5 = -2 → clamped to 0
    expect(adjustedScore).toBeGreaterThanOrEqual(0);
  });

  it('does not push score above 100', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, offer: 5 };
    const { adjustedScore } = applyCompanyHistoryNudge(97, 0, history);
    expect(adjustedScore).toBeLessThanOrEqual(100);
  });
});

describe('applyCompanyHistoryNudge — reasoning line', () => {
  it('returns a non-null reasoningLine when there is relevant history', () => {
    const history: CompanyOutcomeCounts = { ...noHistory, rejected: 1 };
    const { reasoningLine } = applyCompanyHistoryNudge(50, 30, history);
    expect(reasoningLine).not.toBeNull();
    expect(typeof reasoningLine).toBe('string');
  });

  it('reasoning line contains no raw double quotes, newlines, or markdown', () => {
    const outcomes: Array<keyof CompanyOutcomeCounts> = [
      'rejected', 'no_response', 'heard_back', 'interview', 'offer',
    ];
    for (const outcome of outcomes) {
      const history: CompanyOutcomeCounts = { ...noHistory, [outcome]: 1 };
      const { reasoningLine } = applyCompanyHistoryNudge(50, 30, history);
      if (reasoningLine) {
        expect(reasoningLine).not.toMatch(/"/);
        expect(reasoningLine).not.toMatch(/\n/);
        expect(reasoningLine).not.toMatch(/[*_`#]/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// composeReasoningWithHistory
// ---------------------------------------------------------------------------

describe('composeReasoningWithHistory', () => {
  it('returns model reasoning unchanged when historyLine is null', () => {
    expect(composeReasoningWithHistory('Sentence one. Sentence two.', null))
      .toBe('Sentence one. Sentence two.');
  });

  it('returns model reasoning unchanged when historyLine is empty string', () => {
    expect(composeReasoningWithHistory('Sentence one.', '')).toBe('Sentence one.');
  });

  it('returns model reasoning unchanged when historyLine is whitespace-only', () => {
    expect(composeReasoningWithHistory('Sentence one.', '   ')).toBe('Sentence one.');
  });

  it('appends historyLine as 3rd sentence when model has 2 sentences', () => {
    const result = composeReasoningWithHistory(
      'Sentence one. Sentence two.',
      'History note.'
    );
    expect(result).toBe('Sentence one. Sentence two. History note.');
  });

  it('truncates model to 2 sentences when model has 3 before appending history', () => {
    const result = composeReasoningWithHistory(
      'Sentence one. Sentence two. Sentence three.',
      'History note.'
    );
    expect(result).toBe('Sentence one. Sentence two. History note.');
  });

  it('result has no leading or trailing whitespace', () => {
    const result = composeReasoningWithHistory('  Sentence one.  ', ' History note. ');
    expect(result).toBe(result.trim());
  });

  it('result contains no newlines', () => {
    const result = composeReasoningWithHistory('Sentence one.', 'History note.');
    expect(result).not.toMatch(/\n/);
  });

  it('handles model reasoning that does not end in punctuation', () => {
    const result = composeReasoningWithHistory('Sentence one', 'History note.');
    expect(result).toBe('Sentence one History note.');
  });
});

// ---------------------------------------------------------------------------
// normalizeCompanyName — Unicode coverage (Fix 3)
// ---------------------------------------------------------------------------

describe('normalizeCompanyName — Unicode coverage', () => {
  it('keeps CJK characters intact', () => {
    const result = normalizeCompanyName('腾讯');
    expect(result).toBe('腾讯');
  });

  it('keeps Cyrillic characters intact', () => {
    const result = normalizeCompanyName('Яндекс');
    expect(result).toBe('яндекс');
  });

  it('still strips AT&T to att (Latin punctuation removed)', () => {
    expect(normalizeCompanyName('AT&T')).toBe('att');
  });

  it('still strips Yahoo! to yahoo', () => {
    expect(normalizeCompanyName('Yahoo!')).toBe('yahoo');
  });

  it('still normalizes Nestlé to nestle via diacritic strip', () => {
    expect(normalizeCompanyName('Nestlé')).toBe('nestle');
  });

  it('Acme Inc. still normalizes to acme', () => {
    expect(normalizeCompanyName('Acme Inc.')).toBe('acme');
  });

  it('Acme still does not equal Acme Health', () => {
    expect(normalizeCompanyName('Acme')).not.toBe(normalizeCompanyName('Acme Health'));
  });
});
