import { isJobLocationMismatch, JobForFiltering } from "../utils/preferenceFilters";

function makeJob(location: string[]): JobForFiltering {
  return { source: "test", location };
}

describe("isJobLocationMismatch — globally-open and agnostic-pref smoke tests", () => {
  // globally-open job
  test("worldwide job kept for India pref", () => {
    expect(isJobLocationMismatch(makeJob(["Worldwide"]), ["India"])).toBe(false);
  });

  test("anywhere-in-the-world job kept for India pref", () => {
    expect(isJobLocationMismatch(makeJob(["Anywhere in the world"]), ["India"])).toBe(false);
  });

  test("Himalayas Remote+Worldwide kept for India pref", () => {
    expect(isJobLocationMismatch(makeJob(["Remote", "Worldwide"]), ["India"])).toBe(false);
  });

  // agnostic pref
  test("Remote pref bypasses geo-filter", () => {
    expect(isJobLocationMismatch(makeJob(["San Francisco"]), ["Remote"])).toBe(false);
  });

  test("Remote+United States pref is NOT agnostic — India job is a mismatch", () => {
    // ["Remote", "United States"] is not all-agnostic (United States is a geography) -> falls through to substring
    // "india" does not substring-match "remote" or "united states" -> mismatch
    expect(isJobLocationMismatch(makeJob(["India"]), ["Remote", "United States"])).toBe(true);
  });

  test("Remote+India pref: India job still matches", () => {
    expect(isJobLocationMismatch(makeJob(["India"]), ["Remote", "India"])).toBe(false);
  });

  // false-positive avoidance
  test("'Global, Brazil' is NOT treated as globally open", () => {
    expect(isJobLocationMismatch(makeJob(["Global, Brazil"]), ["India"])).toBe(true);
  });

  // blank entry safety
  test("all-blank pref entries -> no filter", () => {
    expect(isJobLocationMismatch(makeJob(["New York"]), ["", "  "])).toBe(false);
  });

  test("blank pref entries stripped; mismatch detected on remaining entries", () => {
    expect(isJobLocationMismatch(makeJob(["New York"]), ["", "London"])).toBe(true);
  });
});
