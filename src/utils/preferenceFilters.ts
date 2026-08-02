// Structural types — no mongoose imports, no DB access, no OpenAI.
// Everything in this file is a pure function over plain data.

export interface JobForFiltering {
  location?: string[];
  tags?: string[];
  source: string;
  salary?: {
    max?: number;
  };
}

export interface UserPrefsForFiltering {
  remoteOnly?: boolean;
  minSalary?: number;
  location?: string[];
}

export interface FilterResult<T> {
  kept: T[];
  remoteSkipped: T[];
  salarySkipped: T[];
  locationSkipped: T[];
}

// isJobRemote logic is inlined so this module is self-contained across repos.
// "remote" as a whole word, excluding known non-remote compounds.
const POSITIVE_PATTERNS: RegExp[] = [
  /\bremote\b(?!\s+(?:sensing|access|control|desktop|monitoring|patient|learning|viewing))/i,
  /\bworldwide\b/i,
  /\banywhere\b/i,
  /\bglobal\b/i,
  /\bdistributed\b/i,
  /\bwfh\b/i,
  /\bwork\s+from\s+anywhere\b/i,
  /\bfully\s+remote\b/i,
  /\bwork\s+from\s+home\b/i,
];

// Checked ONLY against job.location[] — "hybrid" and similar are common tech terms in
// other fields. Work-arrangement words in location[] are unambiguous; elsewhere they are not.
const NEGATIVE_PATTERNS: RegExp[] = [
  /\bonsite\b/i,
  /\bon-site\b/i,
  /\boffice-based\b/i,
  /\boffice\s+based\b/i,
  /\bin-office\b/i,
  /\bin\s+office\b/i,
  /\bhybrid\b/i,
  /\brelocation\s+required\b/i,
];

// Remote-only job board families — a job from these sources is remote even without a keyword.
const TRUSTED_SOURCE_PREFIXES = [
  "tryremote",
  "weworkremotely",
  "nodesk",
  "wellfound",
  "web3 careers",
  "cryptocurrency jobs",
  "remoteok",
  "remote.co",
];

function hasPositiveKeyword(strings: string[]): boolean {
  return strings.some((s) => POSITIVE_PATTERNS.some((re) => re.test(s)));
}

function hasNegativeSignalInLocation(location: string[]): boolean {
  return location.some((s) => NEGATIVE_PATTERNS.some((re) => re.test(s)));
}

function isTrustedSource(source: string): boolean {
  const lower = source.toLowerCase().trim();
  return TRUSTED_SOURCE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isJobRemote(job: JobForFiltering): boolean {
  const location = job.location ?? [];

  if (hasNegativeSignalInLocation(location)) {
    return false;
  }

  const locationAndTags = [...location, ...(job.tags ?? [])];

  if (hasPositiveKeyword(locationAndTags)) {
    return true;
  }

  if (isTrustedSource(job.source)) {
    return true;
  }

  return false;
}

/**
 * Returns true when the job should be SKIPPED for salary reasons.
 * No filter when: user min salary is 0/missing/negative, or job has no salary max, or max <= 0.
 * Filters ONLY when job.salary.max is strictly below user's minSalary.
 */
export function isJobSalaryTooLow(job: JobForFiltering, minSalary?: number): boolean {
  if (!minSalary || minSalary <= 0) {
    return false;
  }

  if (!job.salary || !job.salary.max || job.salary.max <= 0) {
    return false;
  }

  return job.salary.max < minSalary;
}

/**
 * Returns true when the job should be SKIPPED for location reasons.
 * No filter when: user has no location preferences, or job has no location.
 * Matching is case-insensitive substring in BOTH directions.
 */
export function isJobLocationMismatch(job: JobForFiltering, userLocations?: string[]): boolean {
  if (!userLocations || userLocations.length === 0) {
    return false;
  }

  if (!job.location || job.location.length === 0) {
    return false;
  }

  const jobLocsLower = job.location.map((loc) => loc.toLowerCase());
  const userLocsLower = userLocations.map((loc) => loc.toLowerCase());

  for (const jobLoc of jobLocsLower) {
    for (const userLoc of userLocsLower) {
      if (jobLoc.includes(userLoc) || userLoc.includes(jobLoc)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Applies preference filters in the load-bearing order: remote → salary → location.
 *
 * A job failing more than one filter is placed in the FIRST applicable category.
 * This preserves the skip-reason semantics of the nightly matcher — the recorded reason
 * feeds preference learning, so reordering would silently corrupt that data.
 */
export function applyPreferenceFilters<T extends JobForFiltering>(
  jobs: T[],
  prefs: UserPrefsForFiltering
): FilterResult<T> {
  const remoteSkipped: T[] = [];
  const salarySkipped: T[] = [];
  const locationSkipped: T[] = [];
  const kept: T[] = [];

  const minSalary = prefs.minSalary ?? 0;
  const userLocations = prefs.location ?? [];

  for (const job of jobs) {
    if (prefs.remoteOnly === true && !isJobRemote(job)) {
      remoteSkipped.push(job);
    } else if (isJobSalaryTooLow(job, minSalary)) {
      salarySkipped.push(job);
    } else if (isJobLocationMismatch(job, userLocations)) {
      locationSkipped.push(job);
    } else {
      kept.push(job);
    }
  }

  return { kept, remoteSkipped, salarySkipped, locationSkipped };
}
