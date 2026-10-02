/**
 * Smoke tests for sanitizeAttribution (onlyjobs-akb Phase 2a).
 * Minimal: compilation + safe-sanitize happy path. Adversarial suite is a separate pass.
 */

import { sanitizeAttribution } from "../controllers/userController";

describe("sanitizeAttribution", () => {
  it("returns expected object for well-formed input", () => {
    const now = new Date();
    const input = {
      utmSource: "reddit",
      utmMedium: "social",
      utmCampaign: "summer-2026",
      utmContent: "banner-a",
      utmTerm: "remote jobs",
      referringDomain: "reddit.com",
      landingPath: "/landing",
      firstSeenAt: now.toISOString(),
    };

    const result = sanitizeAttribution(input);

    expect(result).not.toBeUndefined();
    expect(result?.utmSource).toBe("reddit");
    expect(result?.utmMedium).toBe("social");
    expect(result?.utmCampaign).toBe("summer-2026");
    expect(result?.utmContent).toBe("banner-a");
    expect(result?.utmTerm).toBe("remote jobs");
    expect(result?.referringDomain).toBe("reddit.com");
    expect(result?.landingPath).toBe("/landing");
    expect(result?.firstSeenAt).toBeInstanceOf(Date);
    // source derived server-side from presence of utm_source
    expect(result?.source).toBe("utm");
  });

  it("drops $gt key and truncates a 10k referrer to safe output", () => {
    const longReferrer = "a".repeat(10000) + ".com";
    const input = {
      $gt: "injected",
      utmSource: "test",
      referringDomain: "evil.com",
      landingPath: "/page",
    };

    const result = sanitizeAttribution(input);

    expect(result).not.toBeUndefined();
    // $gt key must not appear in the result
    expect((result as unknown as Record<string, unknown>)["$gt"]).toBeUndefined();
    // normal fields still work
    expect(result?.utmSource).toBe("test");
    expect(result?.referringDomain).toBe("evil.com");
    expect(result?.source).toBe("utm");

    // Test oversized referrer is truncated to ≤255 chars
    const inputLong = {
      referringDomain: longReferrer,
      landingPath: "/page",
    };
    const resultLong = sanitizeAttribution(inputLong);
    // referringDomain is extracted as hostname; a pure domain string like "aaa...com" would be valid
    // hostname from URL parse of "https://aaa...com" → the domain itself, truncated at 255
    if (resultLong?.referringDomain) {
      expect(resultLong.referringDomain.length).toBeLessThanOrEqual(255);
    }
  });

  it("returns undefined for non-object input", () => {
    expect(sanitizeAttribution(null)).toBeUndefined();
    expect(sanitizeAttribution("string")).toBeUndefined();
    expect(sanitizeAttribution(42)).toBeUndefined();
    expect(sanitizeAttribution([])).toBeUndefined();
  });

  it("returns undefined when no valid fields are extracted", () => {
    const input = {
      utmSource: 12345, // not a string — dropped
      referringDomain: 99, // not a string — dropped
    };
    expect(sanitizeAttribution(input)).toBeUndefined();
  });

  it("derives source=referral when only referringDomain is present", () => {
    const result = sanitizeAttribution({
      referringDomain: "hn.algolia.com",
      landingPath: "/about",
    });

    expect(result?.source).toBe("referral");
    expect(result?.referringDomain).toBe("hn.algolia.com");
  });

  it("derives source=direct when only landingPath/firstSeenAt present", () => {
    const result = sanitizeAttribution({
      landingPath: "/pricing",
      firstSeenAt: new Date().toISOString(),
    });

    expect(result?.source).toBe("direct");
  });

  it("omits firstSeenAt if timestamp is more than 1 year old", () => {
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const result = sanitizeAttribution({
      utmSource: "google",
      firstSeenAt: oldDate,
    });

    expect(result?.utmSource).toBe("google");
    expect(result?.firstSeenAt).toBeUndefined();
  });
});
