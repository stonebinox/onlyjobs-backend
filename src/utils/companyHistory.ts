export interface CompanyOutcomeCounts {
  heard_back: number;
  no_response: number;
  rejected: number;
  interview: number;
  offer: number;
}

export type CompanyHistoryMap = Map<string, CompanyOutcomeCounts>;

const LEGAL_SUFFIXES = [
  'corporation', 'incorporated', 'limited',
  'corp', 'inc', 'ltd', 'llc', 'llp', 'gmbh', 'co',
];

// Matches: optional comma, then whitespace, then a suffix word, then optional period, at end.
// Whitespace before the suffix ensures we only strip standalone words (not substrings).
const SUFFIX_RE = new RegExp(
  `,?\\s+(${LEGAL_SUFFIXES.join('|')})\\.?$`,
  'i'
);

const VALID_OUTCOMES = new Set<string>([
  'heard_back', 'no_response', 'rejected', 'interview', 'offer',
]);

export function normalizeCompanyName(name: string): string {
  if (!name) return '';
  // NFKD decompose + strip combining characters (diacritics, U+0300-U+036F)
  let n = name.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Lowercase
  n = n.toLowerCase();
  // Collapse whitespace
  n = n.replace(/\s+/g, ' ').trim();
  // Strip trailing legal suffixes repeatedly until stable
  let prev: string;
  do {
    prev = n;
    n = n.replace(SUFFIX_RE, '').trim();
  } while (n !== prev);
  // Remove punctuation/symbols; keep Unicode letters and numbers so CJK/Cyrillic names work
  n = n.replace(/[^\p{L}\p{N} ]/gu, '').trim();
  // Final whitespace collapse
  return n.replace(/\s+/g, ' ').trim();
}

export function buildCompanyHistoryMap(
  records: Array<{ applicationOutcome?: string | null; company: string }>
): CompanyHistoryMap {
  const map: CompanyHistoryMap = new Map();
  for (const record of records) {
    const outcome = record.applicationOutcome;
    if (!outcome || !VALID_OUTCOMES.has(outcome)) continue;
    const company = record.company;
    if (!company) continue;
    const key = normalizeCompanyName(company);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { heard_back: 0, no_response: 0, rejected: 0, interview: 0, offer: 0 });
    }
    const counts = map.get(key)!;
    (counts as unknown as Record<string, number>)[outcome]++;
  }
  return map;
}

const NO_RESPONSE_AGGREGATE_CAP = -2;
const TOTAL_NUDGE_MIN = -5;
const TOTAL_NUDGE_MAX = 5;

function buildHistoryReasoningLine(history: CompanyOutcomeCounts): string {
  const { rejected, no_response, heard_back, interview, offer } = history;
  const hasPositive = heard_back > 0 || interview > 0 || offer > 0;
  const hasNegative = rejected > 0 || no_response > 0;

  if (offer > 0) {
    return 'You have a prior offer here - this company knows your profile and engages.';
  }
  if (interview > 0) {
    return 'You have reached the interview stage here before - a positive signal they engage with you.';
  }
  if (heard_back > 0 && !hasNegative) {
    return 'This company has responded to you before - they engage with applications.';
  }
  if (rejected > 0 && no_response === 0) {
    return 'You have applied here before and were rejected - consider whether role or skill fit has changed.';
  }
  if (no_response > 0 && rejected === 0) {
    return 'You have applied here before without a response - their process may be slow or high-volume.';
  }
  if (hasPositive && hasNegative) {
    return 'You have mixed history here - prior positive engagement but also some rejections or no responses.';
  }
  return 'You have applied here before without a positive outcome - their process may not be responsive.';
}

export function applyCompanyHistoryNudge(
  baseScore: number,
  minScore: number,
  history: CompanyOutcomeCounts | undefined
): { adjustedScore: number; reasoningLine: string | null } {
  if (!history) return { adjustedScore: baseScore, reasoningLine: null };

  const total =
    history.heard_back + history.no_response + history.rejected +
    history.interview + history.offer;
  if (total === 0) return { adjustedScore: baseScore, reasoningLine: null };

  let nudge = 0;
  nudge += history.rejected * -3;
  // no_response: per-record weight -1, but aggregate contribution floored at -2
  nudge += Math.max(history.no_response * -1, NO_RESPONSE_AGGREGATE_CAP);
  nudge += history.heard_back * 1;
  nudge += history.interview * 3;
  nudge += history.offer * 4;
  // Clamp total nudge to [-5, +5]
  nudge = Math.max(TOTAL_NUDGE_MIN, Math.min(TOTAL_NUDGE_MAX, nudge));

  const reasoningLine = buildHistoryReasoningLine(history);

  // GATE INVARIANT: if nudge would flip the score across minScore, apply no numeric nudge
  if (nudge !== 0) {
    const wouldBe = baseScore + nudge;
    if ((baseScore < minScore) !== (wouldBe < minScore)) {
      return { adjustedScore: baseScore, reasoningLine };
    }
  }

  const adjustedScore = Math.max(0, Math.min(100, baseScore + nudge));
  return { adjustedScore, reasoningLine };
}

export function composeReasoningWithHistory(modelReasoning: string, historyLine: string | null): string {
  const trimmed = modelReasoning.trim();
  if (!historyLine || !historyLine.trim()) return trimmed;
  // Keep at most the first 2 model sentences so the appended history line stays within 3 total
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  const kept = sentences.slice(0, 2).join(' ').trimEnd();
  return `${kept} ${historyLine.trim()}`;
}
