/**
 * ADVERSARIAL TEST SUITE — preferenceFilters: globally-open / agnostic-pref bypass
 * (backend copy — mirrors onlyjobs-background/src/utils/__tests__/preferenceFilters.globopen.adversarial.test.ts)
 *
 * Oracle: contract spec only. Implementation bodies were NOT read.
 * A failing test is a FINDING — do NOT weaken tests; fix the implementation.
 *
 * Adversarial focus areas:
 *   1. Whitespace normalization (trim + collapse-ws) for globally-open detection
 *   2. WHOLE-VALUE exact match (not substring) for globally-open detection
 *   3. ALL-entries constraint for agnostic-pref bypass
 *   4. Set asymmetry: globally-open job set ≠ agnostic-pref set
 *   5. Blank entry safety (includes("") trap — on BOTH sides)
 *   6. Pipeline integration: globally-open bypasses locationSkipped bucket
 *   7. Byte parity between repos
 *
 * DISCLOSURE:
 *   - Read: exported interface declarations (lines 1-24 of source) for type info.
 *   - Read: existing test files (preferenceFilters.unit.test.ts, preferenceFilters.parity.test.ts)
 *     for pattern coverage — to write non-redundant tests.
 *   - Incidentally saw: start of POSITIVE_PATTERNS on line 29 (a regex constant). Stopped reading
 *     immediately. Did not encode any implementation detail into assertions.
 *   - Did NOT read: bodies of isJobLocationMismatch, isGloballyOpenLocation,
 *     isGloballyAgnosticPref, normLoc, or any other helper.
 *   - All expected values trace to the contract spec, not to what the code does.
 */

import * as fs from "fs";
import * as path from "path";

import {
  isJobLocationMismatch,
  applyPreferenceFilters,
  JobForFiltering,
  UserPrefsForFiltering,
} from "../utils/preferenceFilters";

function job(location: string[]): JobForFiltering {
  return { source: "test", location };
}

// ─── 1. GLOBALLY-OPEN — case and whitespace normalization variants ─────────────
// Contract: normalized = trim + lowercase + collapse-ws (multiple spaces → single space).
// Globally-open set: {worldwide, global, anywhere, anywhere in the world, everywhere,
//                     work from anywhere, remote worldwide, worldwide remote}
// WHOLE-VALUE only: the normalized entry must EXACTLY equal one of the above.

describe("1. Globally-open kept for specific pref (case/whitespace normalization variants)", () => {
  it("1a: '  WORLDWIDE  ' (leading/trailing space + uppercase) is globally-open for pref ['India']", () => {
    // Bug caught: impl does not trim before comparing — treated as mismatch
    expect(isJobLocationMismatch(job(["  WORLDWIDE  "]), ["India"])).toBe(false);
  });

  it("1b: 'anywhere  in the world' (double internal space) is globally-open for pref ['India']", () => {
    // Bug caught: impl trims but does not collapse internal whitespace
    expect(isJobLocationMismatch(job(["anywhere  in the world"]), ["India"])).toBe(false);
  });

  it("1c: 'ANYWHERE IN THE WORLD' (all-caps) is globally-open for pref ['United States']", () => {
    expect(isJobLocationMismatch(job(["ANYWHERE IN THE WORLD"]), ["United States"])).toBe(false);
  });

  it("1d: '  WORLDWIDE  ' is globally-open for pref ['United States']", () => {
    expect(isJobLocationMismatch(job(["  WORLDWIDE  "]), ["United States"])).toBe(false);
  });

  it("1e: ['Remote', 'Worldwide'] (Himalayas-shaped) is globally-open for pref ['India']", () => {
    // Contract: if ANY entry is in the globally-open set → whole job is globally-open
    expect(isJobLocationMismatch(job(["Remote", "Worldwide"]), ["India"])).toBe(false);
  });

  it("1f: ['Remote', 'Worldwide'] is globally-open for pref ['United States']", () => {
    expect(isJobLocationMismatch(job(["Remote", "Worldwide"]), ["United States"])).toBe(false);
  });

  it("1g: ['Berlin', 'Global'] is globally-open for pref ['India'] (non-first entry)", () => {
    // The globally-open entry does not need to be first
    expect(isJobLocationMismatch(job(["Berlin", "Global"]), ["India"])).toBe(false);
  });

  it("1h: 'worldwide remote' (both words, lowercase) is globally-open for pref ['India']", () => {
    expect(isJobLocationMismatch(job(["worldwide remote"]), ["India"])).toBe(false);
  });

  it("1i: 'Worldwide Remote' (title-case) is globally-open for pref ['India']", () => {
    expect(isJobLocationMismatch(job(["Worldwide Remote"]), ["India"])).toBe(false);
  });

  it("1j: 'WORK  FROM  ANYWHERE' (all-caps + collapsed double spaces) is globally-open", () => {
    // Bug caught: impl normalizes case but not internal whitespace (or vice versa)
    expect(isJobLocationMismatch(job(["WORK  FROM  ANYWHERE"]), ["India"])).toBe(false);
  });

  it("1k: ['US Only', 'Work From Anywhere'] is globally-open (non-first entry is the open signal)", () => {
    expect(isJobLocationMismatch(job(["US Only", "Work From Anywhere"]), ["India"])).toBe(false);
  });

  it("1l: 'remote worldwide' (lowercase) is globally-open for pref ['Brazil']", () => {
    expect(isJobLocationMismatch(job(["remote worldwide"]), ["Brazil"])).toBe(false);
  });

  it("1m: ['Everywhere'] is globally-open for pref ['India']", () => {
    expect(isJobLocationMismatch(job(["Everywhere"]), ["India"])).toBe(false);
  });

  it("1n: [' EVERYWHERE '] (leading/trailing space + all-caps) is globally-open for pref ['India']", () => {
    // Normalization must trim and lowercase before set lookup
    expect(isJobLocationMismatch(job([" EVERYWHERE "]), ["India"])).toBe(false);
  });
});

// ─── 2. COUNTRY RESTRICTIONS still enforced ──────────────────────────────────
// These ensure the bypass does NOT fire for compound job locations or for jobs
// where "remote" appears as one entry but a geographic restriction appears as another.

describe("2. Country restrictions enforced — no silent bypass via partial remote signal", () => {
  it("2a: job ['Remote', 'United States'] IS a mismatch for pref ['India']", () => {
    // Neither entry is in the globally-open set as a whole value.
    // Bug caught: impl treats any job location entry containing 'remote' as globally-open.
    expect(isJobLocationMismatch(job(["Remote", "United States"]), ["India"])).toBe(true);
  });

  it("2b: job ['Remote, United States'] (comma-joined, single entry) IS a mismatch for pref ['India']", () => {
    // Normalized 'remote, united states' is NOT in the globally-open set
    expect(isJobLocationMismatch(job(["Remote, United States"]), ["India"])).toBe(true);
  });

  it("2c: job ['Remote'] alone IS a mismatch for pref ['India'] — 'remote' not in globally-open set", () => {
    // Bug caught: impl treats standalone 'Remote' in job.location as a globally-open bypass.
    // 'remote' is NOT in {worldwide, global, anywhere, anywhere in the world, ...}
    // pref 'India' is not agnostic → substring: 'remote' ↔ 'india' → no match → true
    expect(isJobLocationMismatch(job(["Remote"]), ["India"])).toBe(true);
  });

  it("2d: direct substring match — job ['San Francisco, CA'] for pref ['CA'] is NOT a mismatch", () => {
    // Contract: bidirectional substring — user loc 'CA' is a substring of job loc
    expect(isJobLocationMismatch(job(["San Francisco, CA"]), ["CA"])).toBe(false);
  });

  it("2e: reverse substring match — job ['India'] for pref ['Bangalore, India'] is NOT a mismatch", () => {
    // Contract: bidirectional — job loc 'India' is a substring of user loc 'Bangalore, India'
    expect(isJobLocationMismatch(job(["India"]), ["Bangalore, India"])).toBe(false);
  });

  it("2f: genuine mismatch — job ['United States'] for pref ['India'] IS a mismatch", () => {
    expect(isJobLocationMismatch(job(["United States"]), ["India"])).toBe(true);
  });
});

// ─── 3. AGNOSTIC PREF: bypass boundary and set asymmetry ─────────────────────
// Contract (agnostic-pref set): {remote, anywhere, everywhere, worldwide, global, wfh,
//                                fully remote, work from home, work from anywhere, remote worldwide}
// ALL non-empty pref entries must be in this set for the bypass to fire.
// NOTE: this set ≠ globally-open job set. Two key asymmetries:
//   - 'worldwide remote' is in globally-open job set but NOT in agnostic-pref set
//   - 'anywhere in the world' is in globally-open job set but NOT in agnostic-pref set

describe("3. Agnostic pref: bypass boundary and set asymmetry", () => {
  it("3a: pref ['Remote'] bypasses geo-filter for job ['United States']", () => {
    expect(isJobLocationMismatch(job(["United States"]), ["Remote"])).toBe(false);
  });

  it("3b: pref ['Remote', 'Anywhere'] bypasses geo-filter for job ['United States']", () => {
    // Both in agnostic set → all-agnostic → bypass
    expect(isJobLocationMismatch(job(["United States"]), ["Remote", "Anywhere"])).toBe(false);
  });

  it("3c: pref ['Remote', 'India'] does NOT bypass — 'India' not in agnostic set", () => {
    // One geographic entry disables the bypass; normal filtering applies
    expect(isJobLocationMismatch(job(["United States"]), ["Remote", "India"])).toBe(true);
  });

  it("3d: pref ['India'] alone does NOT bypass", () => {
    expect(isJobLocationMismatch(job(["United States"]), ["India"])).toBe(true);
  });

  it("3e: pref ['Fully Remote'] bypasses for job ['United States']", () => {
    expect(isJobLocationMismatch(job(["United States"]), ["Fully Remote"])).toBe(false);
  });

  it("3f: pref ['wfh'] (lowercase) bypasses for job ['United States']", () => {
    expect(isJobLocationMismatch(job(["United States"]), ["wfh"])).toBe(false);
  });

  it("3g: pref ['Work From Home'] bypasses for job ['Singapore']", () => {
    expect(isJobLocationMismatch(job(["Singapore"]), ["Work From Home"])).toBe(false);
  });

  it("3h: pref ['worldwide'] bypasses for job ['Brazil']", () => {
    expect(isJobLocationMismatch(job(["Brazil"]), ["worldwide"])).toBe(false);
  });

  it("3i: pref ['remote worldwide'] bypasses — 'remote worldwide' IS in agnostic-pref set", () => {
    expect(isJobLocationMismatch(job(["Brazil"]), ["remote worldwide"])).toBe(false);
  });

  it("3j: pref ['worldwide remote'] does NOT bypass — NOT in agnostic-pref set", () => {
    // ADVERSARIAL: 'worldwide remote' IS in the globally-open job set but is NOT in the
    // agnostic-pref set. A buggy impl using a single constant for both sets would
    // incorrectly bypass here.
    expect(isJobLocationMismatch(job(["United States"]), ["worldwide remote"])).toBe(true);
  });

  it("3k: pref ['anywhere in the world'] does NOT bypass — NOT in agnostic-pref set", () => {
    // ADVERSARIAL: 'anywhere in the world' is in globally-open job set but NOT in agnostic-pref set.
    // The agnostic set has 'anywhere' (single word) but not the compound phrase.
    // Bug caught: impl conflates the two sets.
    expect(isJobLocationMismatch(job(["United States"]), ["anywhere in the world"])).toBe(true);
  });

  it("3l: pref ['Remote', 'remote worldwide'] bypasses — both entries in agnostic set", () => {
    expect(isJobLocationMismatch(job(["United States"]), ["Remote", "remote worldwide"])).toBe(false);
  });

  it("3m: pref ['Everywhere'] bypasses geo-filter for job ['Remote', 'United States']", () => {
    // 'everywhere' is in agnostic-pref set → all-agnostic → bypass; job restriction is irrelevant
    expect(isJobLocationMismatch(job(["Remote", "United States"]), ["Everywhere"])).toBe(false);
  });
});

// ─── 4. FALSE-POSITIVE protection: WHOLE-VALUE exact match only ───────────────
// Contract: globally-open detection uses whole-value comparison on the NORMALIZED entry,
// not substring search. A location entry containing an open-indicator word/phrase does
// NOT qualify unless the normalized entry exactly equals one of the open values.

describe("4. False-positive protection: globally-open requires whole-value exact match", () => {
  it("4a: ['Global, Brazil'] is NOT globally-open — 'global, brazil' ≠ 'global'", () => {
    // Comma-joined compound is not the same as the single word
    expect(isJobLocationMismatch(job(["Global, Brazil"]), ["India"])).toBe(true);
  });

  it("4b: ['Anywhereville, TX'] is NOT globally-open — contains 'anywhere' but isn't exactly it", () => {
    // Bug caught: impl uses .includes('anywhere') instead of exact-value check
    expect(isJobLocationMismatch(job(["Anywhereville, TX"]), ["India"])).toBe(true);
  });

  it("4c: ['GlobalTech HQ'] is NOT globally-open — 'global' prefix inside a compound", () => {
    // 'globaltech hq' ≠ 'global'
    expect(isJobLocationMismatch(job(["GlobalTech HQ"]), ["India"])).toBe(true);
  });

  it("4d: ['Remote positions worldwide'] is NOT globally-open — extra words around 'worldwide'", () => {
    // 'remote positions worldwide' ≠ 'worldwide' or 'worldwide remote'
    expect(isJobLocationMismatch(job(["Remote positions worldwide"]), ["India"])).toBe(true);
  });

  it("4e: ['worldwide remote, except India'] is NOT globally-open but is KEPT via substring match", () => {
    // The trailing ', except india' breaks the whole-value match for 'worldwide remote', so this is
    // not recognised as globally-open. It then falls through to the bidirectional-substring clause:
    // the user location token "india" is a substring of the job string, so the pair matches and the
    // job is KEPT (returns false). This is a known limitation of substring matching with
    // negation/exclusion phrases — tracked separately, not a globally-open-recognition issue.
    expect(isJobLocationMismatch(job(["worldwide remote, except India"]), ["India"])).toBe(false);
  });

  it("4f: ['Anywhere'] IS globally-open, but ['Anywhere near San Francisco'] is NOT", () => {
    // 'anywhere' alone exactly matches; 'anywhere near san francisco' does not
    expect(isJobLocationMismatch(job(["Anywhere"]), ["India"])).toBe(false);
    expect(isJobLocationMismatch(job(["Anywhere near San Francisco"]), ["India"])).toBe(true);
  });

  it("4g: ['The Work From Anywhere Platform'] is NOT globally-open — extra words", () => {
    // 'the work from anywhere platform' ≠ 'work from anywhere'
    expect(isJobLocationMismatch(job(["The Work From Anywhere Platform"]), ["India"])).toBe(true);
  });
});

// ─── 5. EMPTY / MALFORMED entries — includes("") trap ────────────────────────
// Contract: blank/whitespace-only entries are ignored on BOTH sides.
// Must never match everything via includes("").

describe("5. Blank/whitespace entries — includes('') trap on both sides", () => {
  it("5a: pref ['', ' '] (all blank) behaves as no-pref → not a mismatch", () => {
    // Bug caught: without stripping, includes('') is always true → wrong match
    expect(isJobLocationMismatch(job(["New York"]), ["", " "])).toBe(false);
  });

  it("5b: pref ['', 'London'] (mixed) → blank stripped; 'New York' ↔ 'London' → mismatch", () => {
    // After stripping blanks: ['London']. No match with 'New York'.
    expect(isJobLocationMismatch(job(["New York"]), ["", "London"])).toBe(true);
  });

  it("5c: pref ['', 'London'] → blank stripped; 'London' ↔ 'London' → NOT a mismatch", () => {
    // Real entry survives the blank-strip; the match still fires correctly
    expect(isJobLocationMismatch(job(["London"]), ["", "London"])).toBe(false);
  });

  it("5d: job.location [''] (single blank entry) behaves as no-location → not a mismatch", () => {
    // Bug caught: blank job.location not stripped; includes('') on any string returns true
    expect(isJobLocationMismatch(job([""]), ["New York"])).toBe(false);
  });

  it("5e: job.location [' '] (whitespace-only entry) behaves as no-location → not a mismatch", () => {
    // Whitespace-only entries must be stripped on the job side too
    expect(isJobLocationMismatch(job([" "]), ["New York"])).toBe(false);
  });

  it("5f: job.location ['', 'London'] → blank stripped; 'London' ↔ 'New York' → mismatch", () => {
    // Real entry survives; 'London' does not match 'New York'
    expect(isJobLocationMismatch(job(["", "London"]), ["New York"])).toBe(true);
  });

  it("5g: job.location ['', 'London'] → real entry still matches pref 'London'", () => {
    // Real entry survives; 'London' matches 'London'
    expect(isJobLocationMismatch(job(["", "London"]), ["London"])).toBe(false);
  });

  it("5h: job.location undefined → no-location → not a mismatch", () => {
    const noLocJob: JobForFiltering = { source: "test" };
    expect(isJobLocationMismatch(noLocJob, ["New York"])).toBe(false);
  });

  it("5i: pref undefined → no-pref → not a mismatch", () => {
    expect(isJobLocationMismatch(job(["New York"]), undefined)).toBe(false);
  });
});

// ─── 6. PIPELINE-LEVEL integration ────────────────────────────────────────────
// These tests call applyPreferenceFilters — the function the matcher and preview
// actually use. Globally-open and agnostic-pref bypasses must route jobs to 'kept',
// NOT 'locationSkipped'. Filter order (remote → salary → location) must be preserved.

describe("6. Pipeline integration: applyPreferenceFilters with globally-open and restricted jobs", () => {
  it("6a: globally-open job in 'kept', not 'locationSkipped', for a specific-location user", () => {
    const openJob: JobForFiltering = { source: "test", location: ["Worldwide"] };
    const restrictedJob: JobForFiltering = { source: "test", location: ["United States"] };
    const prefs: UserPrefsForFiltering = { location: ["India"], remoteOnly: false };

    const result = applyPreferenceFilters([openJob, restrictedJob], prefs);

    // Globally-open job must be in kept, NOT locationSkipped
    expect(result.kept).toContain(openJob);
    expect(result.locationSkipped).not.toContain(openJob);

    // US-only job must be in locationSkipped for an India-pref user
    expect(result.locationSkipped).toContain(restrictedJob);
    expect(result.kept).not.toContain(restrictedJob);
  });

  it("6b: agnostic-pref user sees country-restricted job in 'kept', not 'locationSkipped'", () => {
    // User pref ['Remote'] is all-agnostic → location filter bypasses entirely
    const usJob: JobForFiltering = { source: "test", location: ["United States"] };
    const prefs: UserPrefsForFiltering = { location: ["Remote"], remoteOnly: false };

    const result = applyPreferenceFilters([usJob], prefs);

    expect(result.kept).toContain(usJob);
    expect(result.locationSkipped).not.toContain(usJob);
  });

  it("6c: order preserved — non-remote job with remoteOnly:true goes to remoteSkipped, not locationSkipped", () => {
    // Contract: filter order is remote → salary → location.
    // A non-remote job must be eliminated at the remote gate.
    const nonRemoteJob: JobForFiltering = {
      source: "test",
      location: ["On-site, United States"], // not remote; location also mismatches "India"
    };
    const prefs: UserPrefsForFiltering = { remoteOnly: true, location: ["India"] };

    const result = applyPreferenceFilters([nonRemoteJob], prefs);

    expect(result.remoteSkipped).toContain(nonRemoteJob);
    expect(result.locationSkipped).not.toContain(nonRemoteJob);
    expect(result.kept).not.toContain(nonRemoteJob);
  });

  it("6d: mixed batch routes every job to the correct bucket", () => {
    // Globally-open → kept
    const openJob: JobForFiltering = { source: "test", location: ["anywhere in the world"] };
    // Location mismatch for India user → locationSkipped
    const jpJob: JobForFiltering = { source: "test", location: ["Japan"] };
    // Passes location (India match) but fails salary → salarySkipped
    const indiaLowSalary: JobForFiltering = {
      source: "test",
      location: ["India"],
      salary: { max: 20_000 },
    };
    const prefs: UserPrefsForFiltering = {
      location: ["India"],
      minSalary: 50_000,
      remoteOnly: false,
    };

    const result = applyPreferenceFilters([openJob, jpJob, indiaLowSalary], prefs);

    expect(result.kept).toContain(openJob);
    expect(result.locationSkipped).not.toContain(openJob);

    expect(result.locationSkipped).toContain(jpJob);
    expect(result.kept).not.toContain(jpJob);

    expect(result.salarySkipped).toContain(indiaLowSalary);
    expect(result.kept).not.toContain(indiaLowSalary);
    expect(result.locationSkipped).not.toContain(indiaLowSalary);
  });

  it("6e: whitespace-variant globally-open job lands in 'kept' via pipeline (end-to-end normalization)", () => {
    // Whitespace normalization must work at the applyPreferenceFilters level, not just isJobLocationMismatch
    const openJob: JobForFiltering = { source: "test", location: ["  Anywhere  In  The  World  "] };
    const prefs: UserPrefsForFiltering = { location: ["United States"] };

    const result = applyPreferenceFilters([openJob], prefs);

    expect(result.kept).toContain(openJob);
    expect(result.locationSkipped).not.toContain(openJob);
  });

  it("6f: ['Remote', 'Worldwide'] (Himalayas-shaped) globally-open job ends up in 'kept'", () => {
    const openJob: JobForFiltering = { source: "test", location: ["Remote", "Worldwide"] };
    const prefs: UserPrefsForFiltering = { location: ["India"], remoteOnly: false };

    const result = applyPreferenceFilters([openJob], prefs);

    expect(result.kept).toContain(openJob);
    expect(result.locationSkipped).not.toContain(openJob);
  });
});

// ─── 7. BYTE PARITY ───────────────────────────────────────────────────────────
// Both repo copies must be byte-for-byte identical at all times.

describe("7. Byte parity — backend and background copies must be identical", () => {
  const bePath = path.resolve(__dirname, "../utils/preferenceFilters.ts");
  const bgPath = path.resolve(
    __dirname,
    "../../../onlyjobs-background/src/utils/preferenceFilters.ts"
  );

  it("7a: both files exist", () => {
    expect(fs.existsSync(bePath)).toBe(true);
    expect(fs.existsSync(bgPath)).toBe(true);
  });

  it("7b: file contents are byte-for-byte identical", () => {
    const beContent = fs.readFileSync(bePath, "utf8");
    const bgContent = fs.readFileSync(bgPath, "utf8");
    if (beContent !== bgContent) {
      const beLines = beContent.split("\n");
      const bgLines = bgContent.split("\n");
      const diffs: string[] = [];
      const maxLen = Math.max(beLines.length, bgLines.length);
      for (let i = 0; i < maxLen; i++) {
        if (beLines[i] !== bgLines[i]) {
          diffs.push(
            `Line ${i + 1}:\n  backend:    ${beLines[i] ?? "(missing)"}\n  background: ${bgLines[i] ?? "(missing)"}`
          );
          if (diffs.length >= 5) {
            diffs.push("... (more differences omitted)");
            break;
          }
        }
      }
      throw new Error(`Files differ:\n${diffs.join("\n\n")}`);
    }
    expect(beContent).toBe(bgContent);
  });
});
