/**
 * ADVERSARIAL tests for companyHistory utilities.
 * Oracle: specification only. No implementation source was read.
 * Expected values are derived from the specification, never from "what the code returns."
 */

import {
  normalizeCompanyName,
  buildCompanyHistoryMap,
  applyCompanyHistoryNudge,
  CompanyOutcomeCounts,
} from '../utils/companyHistory';

// ============================================================================
// normalizeCompanyName
// ============================================================================

describe('normalizeCompanyName — empty / blank', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeCompanyName('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeCompanyName('   ')).toBe('');
  });
});

describe('normalizeCompanyName — case & diacritics', () => {
  it('lowercases all characters', () => {
    expect(normalizeCompanyName('ACME')).toBe('acme');
  });

  it('uppercase and lowercase are equal', () => {
    expect(normalizeCompanyName('ACME')).toBe(normalizeCompanyName('acme'));
  });

  it('strips diacritics: Nestlé -> nestle', () => {
    expect(normalizeCompanyName('Nestlé')).toBe('nestle');
  });

  it('strips diacritics: Möbius -> mobius', () => {
    expect(normalizeCompanyName('Möbius')).toBe('mobius');
  });
});

describe('normalizeCompanyName — whitespace', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeCompanyName('  Acme  ')).toBe('acme');
  });

  it('collapses internal whitespace to a single space', () => {
    expect(normalizeCompanyName('Acme   Solutions')).toBe('acme solutions');
  });
});

describe('normalizeCompanyName — suffix stripping (individual suffixes)', () => {
  it('strips trailing "Inc."', () => {
    expect(normalizeCompanyName('Acme Inc.')).toBe('acme');
  });

  it('strips trailing "Inc" (no period)', () => {
    expect(normalizeCompanyName('Acme Inc')).toBe('acme');
  });

  it('strips trailing "Corp"', () => {
    expect(normalizeCompanyName('ACME Corp')).toBe('acme');
  });

  it('strips trailing "LLC" after comma', () => {
    expect(normalizeCompanyName('Acme, LLC')).toBe('acme');
  });

  it('strips trailing "Inc." after comma', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
  });

  it('strips trailing "Ltd"', () => {
    expect(normalizeCompanyName('Acme Ltd')).toBe('acme');
  });

  it('strips trailing "Ltd."', () => {
    expect(normalizeCompanyName('Acme Ltd.')).toBe('acme');
  });

  it('strips trailing "LLP"', () => {
    expect(normalizeCompanyName('Acme LLP')).toBe('acme');
  });

  it('strips trailing "GmbH"', () => {
    expect(normalizeCompanyName('Acme GmbH')).toBe('acme');
  });

  it('strips trailing "Corporation"', () => {
    expect(normalizeCompanyName('Acme Corporation')).toBe('acme');
  });

  it('strips trailing "Incorporated"', () => {
    expect(normalizeCompanyName('Acme Incorporated')).toBe('acme');
  });

  it('strips trailing "Limited"', () => {
    expect(normalizeCompanyName('Acme Limited')).toBe('acme');
  });

  it('strips trailing "Co"', () => {
    expect(normalizeCompanyName('Acme Co')).toBe('acme');
  });

  it('strips trailing "Co."', () => {
    expect(normalizeCompanyName('Acme Co.')).toBe('acme');
  });
});

describe('normalizeCompanyName — repeated suffix stripping', () => {
  it('strips two trailing suffixes: "Acme Inc Ltd" -> "acme"', () => {
    expect(normalizeCompanyName('Acme Inc Ltd')).toBe('acme');
  });

  it('strips two trailing suffixes: "Acme Corp Inc" -> "acme"', () => {
    expect(normalizeCompanyName('Acme Corp Inc')).toBe('acme');
  });

  it('strips two trailing suffixes: "Acme Inc. Ltd." -> "acme"', () => {
    expect(normalizeCompanyName('Acme Inc. Ltd.')).toBe('acme');
  });
});

describe('normalizeCompanyName — suffix must NOT strip embedded / leading / sole-word', () => {
  it('does NOT strip "co" embedded in "Costco" — boundary required', () => {
    expect(normalizeCompanyName('Costco')).toBe('costco');
  });

  it('does NOT mangle "Cisco"', () => {
    expect(normalizeCompanyName('Cisco')).toBe('cisco');
  });

  it('does NOT strip leading "Limited": "Limited Brands" stays "limited brands"', () => {
    expect(normalizeCompanyName('Limited Brands')).toBe('limited brands');
  });

  it('does NOT strip sole-word "Inc"', () => {
    expect(normalizeCompanyName('Inc')).toBe('inc');
  });

  it('does NOT strip sole-word "LLC"', () => {
    expect(normalizeCompanyName('LLC')).toBe('llc');
  });

  it('does NOT strip sole-word "Corp"', () => {
    expect(normalizeCompanyName('Corp')).toBe('corp');
  });

  it('does NOT strip sole-word "Ltd"', () => {
    expect(normalizeCompanyName('Ltd')).toBe('ltd');
  });

  it('does NOT strip sole-word "Co"', () => {
    expect(normalizeCompanyName('Co')).toBe('co');
  });
});

describe('normalizeCompanyName — special character removal', () => {
  it('removes & from "AT&T" -> "att"', () => {
    expect(normalizeCompanyName('AT&T')).toBe('att');
  });

  it('removes trailing ! from "Yahoo!" -> "yahoo"', () => {
    expect(normalizeCompanyName('Yahoo!')).toBe('yahoo');
  });
});

describe('normalizeCompanyName — variant merging (spec: all variants produce the same key)', () => {
  it('all suffix variants of Acme produce identical keys', () => {
    const base = normalizeCompanyName('Acme');
    expect(normalizeCompanyName('Acme Inc.')).toBe(base);
    expect(normalizeCompanyName('Acme Inc')).toBe(base);
    expect(normalizeCompanyName('ACME Corp')).toBe(base);
    expect(normalizeCompanyName('Acme, LLC')).toBe(base);
    expect(normalizeCompanyName('Acme Inc Ltd')).toBe(base);
    expect(normalizeCompanyName('Acme Corporation')).toBe(base);
    expect(normalizeCompanyName('ACME, INC.')).toBe(base);
    expect(normalizeCompanyName('acme limited')).toBe(base);
  });
});

describe('normalizeCompanyName — non-collision (different companies must NOT merge)', () => {
  it('"Acme" and "Acme Health" produce DIFFERENT keys', () => {
    expect(normalizeCompanyName('Acme')).not.toBe(normalizeCompanyName('Acme Health'));
  });

  it('"Acme Inc" and "Acme Health" produce DIFFERENT keys', () => {
    expect(normalizeCompanyName('Acme Inc')).not.toBe(normalizeCompanyName('Acme Health'));
  });

  it('"Costco" and "Cost" produce DIFFERENT keys', () => {
    expect(normalizeCompanyName('Costco')).not.toBe(normalizeCompanyName('Cost'));
  });
});

// ============================================================================
// buildCompanyHistoryMap
// ============================================================================

describe('buildCompanyHistoryMap — invalid outcomes are ignored', () => {
  it('ignores wrong-case outcome "REJECTED"', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'REJECTED' },
    ]);
    expect(map.size).toBe(0);
  });

  it('ignores unknown outcome "ghosted"', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'ghosted' },
    ]);
    expect(map.size).toBe(0);
  });

  it('ignores empty-string outcome', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: '' },
    ]);
    expect(map.size).toBe(0);
  });

  it('ignores null outcome', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: null },
    ]);
    expect(map.size).toBe(0);
  });

  it('ignores undefined applicationOutcome field', () => {
    const map = buildCompanyHistoryMap([{ company: 'Acme' }]);
    expect(map.size).toBe(0);
  });

  it('ignores outcome "unknown"', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'unknown' },
    ]);
    expect(map.size).toBe(0);
  });

  it('ignores "Offer" (wrong case)', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'Offer' },
    ]);
    expect(map.size).toBe(0);
  });
});

describe('buildCompanyHistoryMap — blank/empty company ignored', () => {
  it('ignores records with empty company name', () => {
    const map = buildCompanyHistoryMap([
      { company: '', applicationOutcome: 'rejected' },
    ]);
    expect(map.size).toBe(0);
  });

  it('ignores records with whitespace-only company name', () => {
    const map = buildCompanyHistoryMap([
      { company: '   ', applicationOutcome: 'rejected' },
    ]);
    expect(map.size).toBe(0);
  });
});

describe('buildCompanyHistoryMap — all valid outcomes are counted', () => {
  it('counts "heard_back" correctly', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'heard_back' },
    ]);
    expect(map.get(normalizeCompanyName('Acme'))?.heard_back).toBe(1);
  });

  it('counts "no_response" correctly', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'no_response' },
    ]);
    expect(map.get(normalizeCompanyName('Acme'))?.no_response).toBe(1);
  });

  it('counts "rejected" correctly', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'rejected' },
    ]);
    expect(map.get(normalizeCompanyName('Acme'))?.rejected).toBe(1);
  });

  it('counts "interview" correctly', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'interview' },
    ]);
    expect(map.get(normalizeCompanyName('Acme'))?.interview).toBe(1);
  });

  it('counts "offer" correctly', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'offer' },
    ]);
    expect(map.get(normalizeCompanyName('Acme'))?.offer).toBe(1);
  });
});

describe('buildCompanyHistoryMap — aggregation', () => {
  it('aggregates multiple records for the same company', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'rejected' },
      { company: 'Acme', applicationOutcome: 'rejected' },
      { company: 'Acme', applicationOutcome: 'interview' },
    ]);
    const counts = map.get(normalizeCompanyName('Acme'));
    expect(counts?.rejected).toBe(2);
    expect(counts?.interview).toBe(1);
    expect(counts?.offer).toBe(0);
  });

  it('non-observed outcome fields are 0 (not undefined)', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'rejected' },
    ]);
    const counts = map.get(normalizeCompanyName('Acme'));
    expect(counts?.heard_back).toBe(0);
    expect(counts?.no_response).toBe(0);
    expect(counts?.interview).toBe(0);
    expect(counts?.offer).toBe(0);
  });

  it('merges "Acme" and "ACME Inc." into one entry with summed counts', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'rejected' },
      { company: 'ACME Inc.', applicationOutcome: 'offer' },
    ]);
    expect(map.size).toBe(1);
    const counts = map.get(normalizeCompanyName('Acme'));
    expect(counts?.rejected).toBe(1);
    expect(counts?.offer).toBe(1);
  });

  it('merges "Acme Corp" and "acme" into one entry', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme Corp', applicationOutcome: 'interview' },
      { company: 'acme', applicationOutcome: 'interview' },
    ]);
    expect(map.size).toBe(1);
    expect(map.get(normalizeCompanyName('acme'))?.interview).toBe(2);
  });

  it('keeps different companies as separate map entries', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'rejected' },
      { company: 'Acme Health', applicationOutcome: 'offer' },
    ]);
    expect(map.size).toBe(2);
  });

  it('counts only valid outcomes when mixed with invalid ones for same company', () => {
    const map = buildCompanyHistoryMap([
      { company: 'Acme', applicationOutcome: 'rejected' },
      { company: 'Acme', applicationOutcome: 'REJECTED' },
      { company: 'Acme', applicationOutcome: 'ghosted' },
      { company: 'Acme', applicationOutcome: null },
    ]);
    const counts = map.get(normalizeCompanyName('Acme'));
    expect(counts?.rejected).toBe(1);
  });
});

// ============================================================================
// applyCompanyHistoryNudge
// ============================================================================

const zero: CompanyOutcomeCounts = {
  heard_back: 0, no_response: 0, rejected: 0, interview: 0, offer: 0,
};

describe('applyCompanyHistoryNudge — no history', () => {
  it('returns baseScore unchanged and null reasoningLine when history is undefined', () => {
    const result = applyCompanyHistoryNudge(50, 30, undefined);
    expect(result.adjustedScore).toBe(50);
    expect(result.reasoningLine).toBeNull();
  });

  it('returns baseScore unchanged and null reasoningLine for all-zero history', () => {
    const result = applyCompanyHistoryNudge(50, 30, zero);
    expect(result.adjustedScore).toBe(50);
    expect(result.reasoningLine).toBeNull();
  });
});

describe('applyCompanyHistoryNudge — individual contribution values (minScore=0, baseScore=50)', () => {
  it('rejected contributes -3 per record', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, rejected: 1 }).adjustedScore).toBe(47);
  });

  it('heard_back contributes +1 per record', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, heard_back: 1 }).adjustedScore).toBe(51);
  });

  it('interview contributes +3 per record', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, interview: 1 }).adjustedScore).toBe(53);
  });

  it('offer contributes +4 per record', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, offer: 1 }).adjustedScore).toBe(54);
  });
});

describe('applyCompanyHistoryNudge — no_response floor at -2', () => {
  it('1 no_response = -1 contribution', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, no_response: 1 }).adjustedScore).toBe(49);
  });

  it('2 no_response = -2 contribution (reaches floor)', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, no_response: 2 }).adjustedScore).toBe(48);
  });

  it('3 no_response = -2 contribution (floor enforced, not -3)', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, no_response: 3 }).adjustedScore).toBe(48);
  });

  it('10 no_response = -2 contribution (floor enforced, not -10)', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, no_response: 10 }).adjustedScore).toBe(48);
  });

  it('3 no_response + 1 rejected: floor(-2) + (-3) = -5, clamped to -5', () => {
    expect(
      applyCompanyHistoryNudge(50, 0, { ...zero, no_response: 3, rejected: 1 }).adjustedScore
    ).toBe(45);
  });

  it('10 no_response + 1 rejected: floor(-2) + (-3) = -5 (clamp boundary)', () => {
    expect(
      applyCompanyHistoryNudge(50, 0, { ...zero, no_response: 10, rejected: 1 }).adjustedScore
    ).toBe(45);
  });
});

describe('applyCompanyHistoryNudge — total nudge clamp [-5, +5]', () => {
  it('2 offers: +8 clamped to +5 -> baseScore 50 + 5 = 55', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, offer: 2 }).adjustedScore).toBe(55);
  });

  it('3 interviews: +9 clamped to +5 -> 55', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, interview: 3 }).adjustedScore).toBe(55);
  });

  it('1 offer + 1 interview: +7 clamped to +5 -> 55', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, offer: 1, interview: 1 }).adjustedScore).toBe(55);
  });

  it('2 rejections: -6 clamped to -5 -> 45', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, rejected: 2 }).adjustedScore).toBe(45);
  });

  it('5 rejections: -15 clamped to -5 -> 45', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, rejected: 5 }).adjustedScore).toBe(45);
  });
});

describe('applyCompanyHistoryNudge — mixed histories', () => {
  it('rejected + offer: -3 + 4 = +1 -> 51', () => {
    expect(
      applyCompanyHistoryNudge(50, 0, { ...zero, rejected: 1, offer: 1 }).adjustedScore
    ).toBe(51);
  });

  it('interview + 1 no_response: +3 + (-1) = +2 -> 52', () => {
    expect(
      applyCompanyHistoryNudge(50, 0, { ...zero, interview: 1, no_response: 1 }).adjustedScore
    ).toBe(52);
  });
});

describe('applyCompanyHistoryNudge — GATE INVARIANT', () => {
  it('GATE fires: positive nudge crossing UP from below minScore — adjustedScore stays at baseScore', () => {
    // baseScore=25 < minScore=30; 2 offers -> clampedNudge=+5; adjusted=30
    // (25 < 30) = true, (30 < 30) = false -> OPPOSITE -> gate fires
    const result = applyCompanyHistoryNudge(25, 30, { ...zero, offer: 2 });
    expect(result.adjustedScore).toBe(25);
    expect(result.reasoningLine).not.toBeNull();
  });

  it('GATE fires: negative nudge crossing DOWN from above minScore — adjustedScore stays at baseScore', () => {
    // baseScore=34, minScore=30; 2 rejections -> clampedNudge=-5; adjusted=29
    // (34 < 30) = false, (29 < 30) = true -> OPPOSITE -> gate fires
    const result = applyCompanyHistoryNudge(34, 30, { ...zero, rejected: 2 });
    expect(result.adjustedScore).toBe(34);
    expect(result.reasoningLine).not.toBeNull();
  });

  it('GATE fires: baseScore exactly at minScore with negative nudge', () => {
    // baseScore=30 = minScore=30; 1 rejection -> nudge=-3; adjusted=27
    // (30 < 30) = false, (27 < 30) = true -> OPPOSITE -> gate fires
    const result = applyCompanyHistoryNudge(30, 30, { ...zero, rejected: 1 });
    expect(result.adjustedScore).toBe(30);
    expect(result.reasoningLine).not.toBeNull();
  });

  it('GATE fires: nudge crosses up to EXACTLY minScore', () => {
    // baseScore=27, minScore=30; 1 interview -> nudge=+3; adjusted=30
    // (27 < 30) = true, (30 < 30) = false -> OPPOSITE -> gate fires
    const result = applyCompanyHistoryNudge(27, 30, { ...zero, interview: 1 });
    expect(result.adjustedScore).toBe(27);
    expect(result.reasoningLine).not.toBeNull();
  });

  it('GATE does NOT fire: nudge keeps score on same side (below stays below)', () => {
    // baseScore=20 < minScore=30; heard_back -> nudge=+1; adjusted=21, still below
    const result = applyCompanyHistoryNudge(20, 30, { ...zero, heard_back: 1 });
    expect(result.adjustedScore).toBe(21);
  });

  it('GATE does NOT fire: nudge keeps score on same side (above stays above)', () => {
    // baseScore=50, minScore=30; 1 rejection -> nudge=-3; adjusted=47, still above
    const result = applyCompanyHistoryNudge(50, 30, { ...zero, rejected: 1 });
    expect(result.adjustedScore).toBe(47);
  });

  it('GATE: minScore=100, negative nudge crosses below 100', () => {
    // baseScore=100, minScore=100; 1 rejection -> nudge=-3; adjusted=97
    // (100 < 100) = false, (97 < 100) = true -> OPPOSITE -> gate fires
    const result = applyCompanyHistoryNudge(100, 100, { ...zero, rejected: 1 });
    expect(result.adjustedScore).toBe(100);
    expect(result.reasoningLine).not.toBeNull();
  });

  it('GATE: minScore=0 falsy-zero trap — positive nudge MUST be applied (no gate with minScore=0)', () => {
    // baseScore=25, minScore=0; 2 offers -> clampedNudge=+5; adjusted=30
    // (25 < 0) = false, (30 < 0) = false -> SAME SIDE -> gate must NOT fire
    // Bug trap: `minScore || 30` would substitute 30, making the gate fire incorrectly
    const result = applyCompanyHistoryNudge(25, 0, { ...zero, offer: 2 });
    expect(result.adjustedScore).toBe(30); // NOT 25
  });

  it('GATE: minScore=0 falsy-zero trap — large negative nudge crossing below 0 IS suppressed by gate', () => {
    // baseScore=2, minScore=0; 1 rejection -> nudge=-3; adjusted=-1
    // (2 < 0) = false, (-1 < 0) = true -> OPPOSITE -> gate fires -> adjustedScore=2 (not clamped to 0)
    const result = applyCompanyHistoryNudge(2, 0, { ...zero, rejected: 1 });
    expect(result.adjustedScore).toBe(2); // gate result, not clamp result
  });

  it('GATE: minScore=0, positive baseScore, nudge stays above 0 — gate must NOT fire', () => {
    // baseScore=31, minScore=0; 2 rejections -> clampedNudge=-5; adjusted=26
    // (31 < 0) = false, (26 < 0) = false -> SAME SIDE -> gate doesn't fire
    // Bug trap: `minScore || 30` treats minScore=0 as 30, then (31 < 30)=false, (26 < 30)=true -> gate fires wrongly
    const result = applyCompanyHistoryNudge(31, 0, { ...zero, rejected: 2 });
    expect(result.adjustedScore).toBe(26); // nudge applied, NOT 31
  });

  it('GATE: falsy zero — baseScore=0, minScore=0, positive nudge should be applied', () => {
    // (0 < 0) = false, (4 < 0) = false -> same side -> no gate
    const result = applyCompanyHistoryNudge(0, 0, { ...zero, offer: 1 });
    expect(result.adjustedScore).toBe(4);
  });
});

describe('applyCompanyHistoryNudge — final [0, 100] clamp', () => {
  it('baseScore 98 + positive nudge does not exceed 100', () => {
    // baseScore=98, minScore=0; 2 offers -> clampedNudge=+5; adjusted=103 -> clamped to 100
    const result = applyCompanyHistoryNudge(98, 0, { ...zero, offer: 2 });
    expect(result.adjustedScore).toBe(100);
  });

  it('adjustedScore never goes below 0 when gate does not fire (both sides below minScore)', () => {
    // baseScore=3, minScore=100 (both below 100); 2 rejections -> nudge=-5; adjusted=-2
    // Gate does NOT fire (both below minScore); final clamp brings -2 to 0
    const result = applyCompanyHistoryNudge(3, 100, { ...zero, rejected: 2 });
    expect(result.adjustedScore).toBe(0);
  });
});

describe('applyCompanyHistoryNudge — reasoningLine content rules', () => {
  it('reasoningLine is non-null when there is at least one valid outcome', () => {
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, rejected: 1 }).reasoningLine).not.toBeNull();
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, offer: 1 }).reasoningLine).not.toBeNull();
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, no_response: 1 }).reasoningLine).not.toBeNull();
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, interview: 1 }).reasoningLine).not.toBeNull();
    expect(applyCompanyHistoryNudge(50, 0, { ...zero, heard_back: 1 }).reasoningLine).not.toBeNull();
  });

  it('reasoningLine contains no raw double-quote characters', () => {
    const result = applyCompanyHistoryNudge(50, 0, { ...zero, rejected: 1 });
    expect(result.reasoningLine).not.toMatch(/"/);
  });

  it('reasoningLine contains no newlines', () => {
    const result = applyCompanyHistoryNudge(50, 0, { ...zero, rejected: 2 });
    expect(result.reasoningLine).not.toMatch(/[\n\r]/);
  });

  it('reasoningLine contains no markdown formatting', () => {
    const result = applyCompanyHistoryNudge(50, 0, { ...zero, offer: 1 });
    expect(result.reasoningLine).not.toMatch(/\*\*|^#{1,6} |__|\[.+\]\(.+\)/);
  });

  it('reasoningLine for rejected-only DIFFERS from reasoningLine for no_response-only', () => {
    const rejectedLine = applyCompanyHistoryNudge(50, 0, { ...zero, rejected: 1 }).reasoningLine;
    const noResponseLine = applyCompanyHistoryNudge(50, 0, { ...zero, no_response: 1 }).reasoningLine;
    expect(rejectedLine).not.toBe(noResponseLine);
  });

  it('no_response reasoningLine does not claim explicit rejection (ghosting ≠ rejection)', () => {
    const result = applyCompanyHistoryNudge(50, 0, { ...zero, no_response: 2 });
    expect(result.reasoningLine).not.toMatch(/\breject(ed|ion)?\b/i);
  });

  it('positive history reasoningLine DIFFERS from purely negative history reasoningLine', () => {
    const positive = applyCompanyHistoryNudge(50, 0, { ...zero, offer: 1 }).reasoningLine;
    const negative = applyCompanyHistoryNudge(50, 0, { ...zero, rejected: 2 }).reasoningLine;
    expect(positive).not.toBe(negative);
  });

  it('reasoningLine is still non-null when gate suppresses the numeric nudge', () => {
    // Gate fires (crossing up): baseScore=25, minScore=30, 2 offers
    const result = applyCompanyHistoryNudge(25, 30, { ...zero, offer: 2 });
    expect(result.adjustedScore).toBe(25); // gate suppressed numeric nudge
    expect(result.reasoningLine).not.toBeNull();
    expect(typeof result.reasoningLine).toBe('string');
  });

  it('reasoningLine is still non-null when gate fires (crossing down)', () => {
    const result = applyCompanyHistoryNudge(34, 30, { ...zero, rejected: 2 });
    expect(result.adjustedScore).toBe(34); // gate suppressed
    expect(result.reasoningLine).not.toBeNull();
  });
});

// ============================================================================
// DISCLOSURE
// ============================================================================
//
// Files NOT opened during authorship:
//   - onlyjobs-background/src/utils/companyHistory.ts  (implementation)
//   - backend/src/utils/companyHistory.ts              (implementation)
//   - Any existing *.smoke.test.ts or *.adversarial.test.ts for companyHistory
//
// The import statement `from '../utils/companyHistory'` was written to allow the
// tests to compile; the implementation body was never opened or read.
//
// All expected values in this file are derived from the specification pasted
// in the task prompt. No value was derived from observed runtime behavior.
//
// The following behaviors could NOT be independently verified without reading
// the implementation (recorded as findings / untestable-without-reading):
//   - The exact wording of reasoningLine strings (spec says not to assert exact
//     wording; only difference and absence of prohibited characters is asserted).
//   - Whether whitespace collapse happens before or after special-char removal
//     (e.g., "A & B Corp" — if & is removed first, "A  B" might retain double
//     space; if suffixes are stripped first, order matters). Tests avoid this
//     ambiguous case by using single-token names like AT&T and Yahoo!.
//   - The exact output for strings where suffix stripping would leave only
//     punctuation (e.g., "Inc. LLC") — the spec covers this logically but
//     normalization of the result depends on strip ordering.
