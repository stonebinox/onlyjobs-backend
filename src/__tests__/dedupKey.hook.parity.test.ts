/**
 * Parity test: JobListing pre-save hook enforces dedupKey === computeDedupKey(url) on create.
 * Mirrors the invariant enforced by the identical hook in onlyjobs-background.
 * MongoMemoryServer provided globally by src/__tests__/setup.ts.
 */

import JobListing, { computeDedupKey } from "../models/JobListing";

function makeJobListing(url: string, overrides: Record<string, unknown> = {}) {
  return {
    title: "Test Job",
    company: "TestCo",
    location: ["Remote"],
    source: "test",
    description: "A description.",
    url,
    ...overrides,
  };
}

describe("JobListing pre-save hook — dedupKey parity with onlyjobs-background", () => {
  test("hook sets dedupKey = computeDedupKey(url) when dedupKey is omitted", async () => {
    const url = "https://example.com/job-parity-1";
    const doc = await JobListing.create(makeJobListing(url));
    expect(doc.dedupKey).toBe(computeDedupKey(url));
    expect(doc.dedupKey).toBe("https://example.com/job-parity-1");
  });

  test("hook overrides a caller-supplied wrong dedupKey — invariant always wins", async () => {
    const url = "https://example.com/job-parity-2";
    const doc = await JobListing.create(makeJobListing(url, { dedupKey: "caller-supplied-wrong-key" }));
    expect(doc.dedupKey).toBe(computeDedupKey(url));
    expect(doc.dedupKey).not.toBe("caller-supplied-wrong-key");
  });

  test("hook normalizes url casing — uppercase url yields lowercase dedupKey", async () => {
    const url = "HTTPS://EXAMPLE.COM/JOB-PARITY-3";
    const doc = await JobListing.create(makeJobListing(url));
    expect(doc.dedupKey).toBe(computeDedupKey(url));
    expect(doc.dedupKey).toBe("https://example.com/job-parity-3");
  });

  test("hook trims whitespace in url before computing dedupKey", async () => {
    const url = "  https://example.com/job-parity-4  ";
    const doc = await JobListing.create(makeJobListing(url));
    expect(doc.dedupKey).toBe(computeDedupKey(url));
    expect(doc.dedupKey).toBe("https://example.com/job-parity-4");
  });
});
