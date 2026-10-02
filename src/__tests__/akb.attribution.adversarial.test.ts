/**
 * ADVERSARIAL test suite — onlyjobs-akb attribution, backend.
 * Oracle: the contract and requirement spec — NOT the implementation.
 * Do NOT weaken a failing test. Failures are FINDINGS.
 *
 * Tests 1-4: supertest + real Mongoose (mongodb-memory-server via setup.ts)
 * Tests 5-7: sanitizeAttribution unit tests, real function
 */

process.env.JWT_SECRET = "test-jwt-secret";

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({}),
}));

jest.mock("bcrypt", () => ({
  hash: (_password: string, _saltRounds: number) =>
    Promise.resolve(`hashed_${_password}`),
  compare: (password: string, hash: string) =>
    Promise.resolve(hash === `hashed_${password}`),
}));

jest.mock("../services/emailService", () => ({
  sendInitialVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendEmailChangeVerificationEmail: jest.fn().mockResolvedValue(true),
  sendMatchingEnabledEmail: jest.fn().mockResolvedValue(true),
  sendMatchingDisabledEmail: jest.fn().mockResolvedValue(true),
  sendAdminUserVerifiedEmail: jest.fn().mockResolvedValue(true),
}));

jest.mock("../services/analyticsService", () => ({
  captureLifecycleEvent: jest.fn(),
}));

import request from "supertest";
import express from "express";
import userRoutes from "../routes/userRoutes";
import User from "../models/User";
import { sanitizeAttribution } from "../controllers/userController";
import * as analyticsService from "../services/analyticsService";

const testApp = express();
testApp.use(express.json());
testApp.use("/api/users", userRoutes);
testApp.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const status = res.statusCode !== 200 ? res.statusCode : 500;
    res.status(status).json({ error: err.message });
  }
);

// ───────────────────────────────────────────────────────────────────────────
// CASE 1: New signup, well-formed attribution
// Oracle: DB row has attribution.utmSource==='reddit', source==='utm',
//         ONLY allowlisted fields present.
// ───────────────────────────────────────────────────────────────────────────
describe("CASE 1: new signup with well-formed UTM attribution", () => {
  it("persists allowlisted attribution fields and derives source=utm", async () => {
    const res = await request(testApp)
      .post("/api/users/auth")
      .send({
        email: "case1@example.com",
        password: "testpassword",
        attribution: {
          utmSource: "reddit",
          utmMedium: "social",
          utmCampaign: "summer-2026",
          utmContent: "banner-a",
          utmTerm: "remote jobs",
          referringDomain: "reddit.com",
          landingPath: "/landing",
          firstSeenAt: new Date().toISOString(),
        },
      });

    // Signup must succeed
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);

    const user = await User.findOne({ email: "case1@example.com" });
    expect(user).not.toBeNull();

    const attr = user!.attribution;
    expect(attr).toBeDefined();
    // Oracle from spec: utmSource present -> source='utm'
    expect(attr!.source).toBe("utm");
    expect(attr!.utmSource).toBe("reddit");
    expect(attr!.utmMedium).toBe("social");
    expect(attr!.utmCampaign).toBe("summer-2026");
    expect(attr!.utmContent).toBe("banner-a");
    expect(attr!.utmTerm).toBe("remote jobs");
    expect(attr!.referringDomain).toBe("reddit.com");
    expect(attr!.landingPath).toBe("/landing");
    expect(attr!.firstSeenAt).toBeInstanceOf(Date);

    // ONLY allowlisted fields: no extra keys
    const attrKeys = Object.keys(
      (user!.toObject().attribution as Record<string, unknown>) ?? {}
    );
    const allowlisted = [
      "source",
      "utmSource",
      "utmMedium",
      "utmCampaign",
      "utmContent",
      "utmTerm",
      "referringDomain",
      "landingPath",
      "firstSeenAt",
      "_id", // Mongoose may add _id to subdocs
    ];
    for (const key of attrKeys) {
      expect(allowlisted).toContain(key);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CASE 2: Malicious attribution — injection, oversized, URL with creds
// Oracle from spec:
//   - user still created
//   - utmSource truncated to 200 chars
//   - '$gt', 'extra' keys NOT stored
//   - referringDomain = 'evil.com' (hostname only, no auth/path/query)
//   - landingPath = '/a' (no query string)
//   - no prototype pollution
// ───────────────────────────────────────────────────────────────────────────
describe("CASE 2: malicious attribution payload", () => {
  it("creates user, sanitizes malicious fields, no prototype pollution", async () => {
    // Use JSON.parse so __proto__ key is a regular own property (not prototype setter)
    const malicious = JSON.parse(
      JSON.stringify({
        utmSource: "x".repeat(10000),
        extra: "shouldBeDropped",
        referringDomain: "https://user:pass@evil.com/p?q=ssn",
        landingPath: "/a?token=secret",
        firstSeenAt: new Date().toISOString(),
      })
    );
    // Add $gt and __proto__ as own properties via Object.defineProperty
    Object.defineProperty(malicious, "$gt", {
      value: 1,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(malicious, "__proto__", {
      value: { admin: true },
      enumerable: true,
      configurable: true,
    });

    const res = await request(testApp)
      .post("/api/users/auth")
      .send({
        email: "case2@example.com",
        password: "testpassword",
        attribution: malicious,
      });

    // User must still be created (fail-open for invalid attribution)
    expect(res.body.token).toBeDefined();
    const success = res.status >= 200 && res.status < 300;
    expect(success).toBe(true);

    const user = await User.findOne({ email: "case2@example.com" });
    expect(user).not.toBeNull();

    const attr = user!.attribution;
    // Attribution MUST exist — an implementation that drops all attribution FAILS here
    expect(attr).toBeDefined();

    // utmSource truncated to max 200 chars (oracle: spec says "max 200")
    expect(attr!.utmSource!.length).toBeLessThanOrEqual(200);
    expect(attr!.utmSource).toBe("x".repeat(200));

    // source derived: utmSource is present -> source='utm'
    expect(attr!.source).toBe("utm");

    // '$gt' must not be stored
    expect((attr as unknown as Record<string, unknown>)["$gt"]).toBeUndefined();

    // 'extra' must not be stored
    expect((attr as unknown as Record<string, unknown>)["extra"]).toBeUndefined();

    // '__proto__' must not be stored as an own property
    expect(Object.prototype.hasOwnProperty.call(attr, "__proto__")).toBe(false);

    // referringDomain: hostname only, no auth info, no path, no query
    // Oracle: 'https://user:pass@evil.com/p?q=ssn' -> hostname is 'evil.com'
    expect(attr!.referringDomain).toBe("evil.com");

    // landingPath: pathname only, no query string
    // Oracle: '/a?token=secret' -> '/a'
    expect(attr!.landingPath).toBe("/a");

    // Prototype pollution check: __proto__ processing must not pollute Object.prototype
    // Oracle: spec says "__proto__/constructor [keys] ignored"
    expect(({} as any).admin).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CASE 3: Existing user login with attribution in body
// Oracle: attribution NEVER written/overwritten on login
// ───────────────────────────────────────────────────────────────────────────
describe("CASE 3: existing user login with attribution must not overwrite", () => {
  it("preserves original attribution when existing user logs in with different attribution", async () => {
    // Create user WITH known attribution directly in DB
    // Note: controller requires password ≥ 8 chars (validated before lookup)
    await User.create({
      email: "case3a@example.com",
      password: "hashed_testpassword1",
      attribution: {
        source: "utm",
        utmSource: "original-source",
        landingPath: "/original-path",
        firstSeenAt: new Date("2026-01-01"),
      },
    });

    // Login with DIFFERENT attribution
    const res = await request(testApp)
      .post("/api/users/auth")
      .send({
        email: "case3a@example.com",
        password: "testpassword1",
        attribution: {
          utmSource: "new-source-should-not-overwrite",
          landingPath: "/new-path",
          firstSeenAt: new Date().toISOString(),
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);

    const user = await User.findOne({ email: "case3a@example.com" });
    expect(user).not.toBeNull();

    // Oracle: attribution must be unchanged from original
    expect(user!.attribution!.utmSource).toBe("original-source");
    expect(user!.attribution!.landingPath).toBe("/original-path");
    expect(user!.attribution!.source).toBe("utm");
    expect(user!.attribution!.utmSource).not.toBe(
      "new-source-should-not-overwrite"
    );
  });

  it("does not set attribution on login when user was created without attribution", async () => {
    // Create user WITHOUT attribution
    // Note: controller requires password ≥ 8 chars (validated before lookup)
    await User.create({
      email: "case3b@example.com",
      password: "hashed_testpassword2",
    });

    // Login with attribution in body
    const res = await request(testApp)
      .post("/api/users/auth")
      .send({
        email: "case3b@example.com",
        password: "testpassword2",
        attribution: {
          utmSource: "post-login-source",
          landingPath: "/landing",
          firstSeenAt: new Date().toISOString(),
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);

    const user = await User.findOne({ email: "case3b@example.com" });
    expect(user).not.toBeNull();

    // Oracle: existing user without attribution must remain without attribution
    expect(user!.attribution).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CASE 4: Failed auth — wrong password
// Oracle: no new user row created; response is 401
// ───────────────────────────────────────────────────────────────────────────
describe("CASE 4: failed auth does not create user", () => {
  it("returns 401 and does not persist a user row for wrong password", async () => {
    // Create user first
    await User.create({
      email: "case4@example.com",
      password: "hashed_correctpassword",
    });

    const countBefore = await User.countDocuments();

    const res = await request(testApp)
      .post("/api/users/auth")
      .send({
        email: "case4@example.com",
        password: "wrongpassword",
        attribution: {
          utmSource: "should-not-be-stored",
        },
      });

    expect(res.status).toBe(401);

    // Oracle: failed auth -> no new user row
    const countAfter = await User.countDocuments();
    expect(countAfter).toBe(countBefore);

    // User's attribution must remain unchanged (was undefined to begin with)
    const user = await User.findOne({ email: "case4@example.com" });
    expect(user!.attribution).toBeUndefined();
  });

  it("wrong password: no lifecycle event emitted and no user row created", async () => {
    await User.create({
      email: "case4b@example.com",
      password: "hashed_rightpassword",
    });

    // Clear any calls accumulated from earlier tests in this suite
    (analyticsService.captureLifecycleEvent as jest.Mock).mockClear();
    const countBefore = await User.countDocuments();

    const res = await request(testApp)
      .post("/api/users/auth")
      .send({
        email: "case4b@example.com",
        password: "wrongpassword",
        attribution: { utmSource: "should-not-fire-analytics" },
      });

    expect(res.status).toBe(401);

    // Oracle: failed auth must NOT emit any lifecycle event
    expect(analyticsService.captureLifecycleEvent).not.toHaveBeenCalled();

    // Oracle: no user row created
    const countAfter = await User.countDocuments();
    expect(countAfter).toBe(countBefore);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CASE 5: sanitizeAttribution — firstSeenAt boundary conditions
// Oracle: [now-1year, now+5min] is the valid window; outside -> omitted
// ───────────────────────────────────────────────────────────────────────────
describe("CASE 5: firstSeenAt boundary conditions", () => {
  it("omits firstSeenAt when timestamp is far in the future (now + 1 year)", () => {
    const farFuture = new Date(
      Date.now() + 366 * 24 * 60 * 60 * 1000
    ).toISOString();
    const result = sanitizeAttribution({
      utmSource: "test",
      firstSeenAt: farFuture,
    });
    // Oracle: future beyond now+5min is rejected
    expect(result?.firstSeenAt).toBeUndefined();
    // But other fields must still be processed
    expect(result?.utmSource).toBe("test");
  });

  it("omits firstSeenAt when timestamp is far in the past (1970-01-01)", () => {
    const epoch = new Date(0).toISOString(); // 1970-01-01
    const result = sanitizeAttribution({
      utmSource: "test",
      firstSeenAt: epoch,
    });
    // Oracle: more than 1 year ago is rejected
    expect(result?.firstSeenAt).toBeUndefined();
    expect(result?.utmSource).toBe("test");
  });

  it("keeps firstSeenAt when timestamp is valid and recent", () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    const result = sanitizeAttribution({
      utmSource: "test",
      firstSeenAt: recent,
    });
    // Oracle: valid date within window -> kept as Date instance
    expect(result?.firstSeenAt).toBeInstanceOf(Date);
    expect(result?.firstSeenAt!.getTime()).toBeGreaterThan(0);
  });

  it("omits firstSeenAt when value is not a valid date string", () => {
    const result = sanitizeAttribution({
      utmSource: "test",
      firstSeenAt: "not-a-date",
    });
    expect(result?.firstSeenAt).toBeUndefined();
    expect(result?.utmSource).toBe("test");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CASE 6: sanitizeAttribution — non-object inputs
// Oracle: all non-object inputs -> undefined; must not throw
// ───────────────────────────────────────────────────────────────────────────
describe("CASE 6: non-object inputs to sanitizeAttribution", () => {
  const nonObjects = [
    ["null", null],
    ["undefined", undefined],
    ["string", "a-string"],
    ["number", 42],
    ["array", []],
    ["boolean true", true],
    ["boolean false", false],
  ] as const;

  for (const [label, input] of nonObjects) {
    it(`returns undefined without throwing for input: ${label}`, () => {
      expect(() => sanitizeAttribution(input as unknown)).not.toThrow();
      expect(sanitizeAttribution(input as unknown)).toBeUndefined();
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// CASE 7: sanitizeAttribution — source derivation and "returns undefined"
// Oracle (spec):
//   utm present -> source='utm'
//   only referringDomain -> source='referral'
//   only landingPath (no utm, no referrer) -> source='direct'
//   nothing valid -> undefined
// ───────────────────────────────────────────────────────────────────────────
describe("CASE 7: source derivation and undefined on empty input", () => {
  it("source=direct when only landingPath=/about is present", () => {
    const result = sanitizeAttribution({ landingPath: "/about" });
    // Oracle: no utm, no referringDomain -> direct
    expect(result?.source).toBe("direct");
    expect(result?.landingPath).toBe("/about");
  });

  it("source=referral when only referringDomain is present", () => {
    const result = sanitizeAttribution({ referringDomain: "hn.algolia.com" });
    // Oracle: referringDomain present, no utm -> referral
    expect(result?.source).toBe("referral");
    expect(result?.referringDomain).toBe("hn.algolia.com");
  });

  it("source=utm when utmSource is present alongside referringDomain", () => {
    const result = sanitizeAttribution({
      utmSource: "twitter",
      referringDomain: "t.co",
    });
    // Oracle: utm present -> utm wins over referral
    expect(result?.source).toBe("utm");
  });

  it("returns undefined when no valid data beyond source", () => {
    // Only non-string values — none extractable
    const result = sanitizeAttribution({
      utmSource: 12345,
      referringDomain: {},
      landingPath: 999,
    });
    // Oracle: returns undefined if no valid data beyond source
    expect(result).toBeUndefined();
  });

  it("landingPath: strips query string, keeps pathname only", () => {
    const result = sanitizeAttribution({
      landingPath: "/pricing?plan=pro&ref=email",
    });
    // Oracle: pathname only, NO query string
    expect(result?.landingPath).toBe("/pricing");
  });

  it("landingPath: ignored if does not start with /", () => {
    const result = sanitizeAttribution({
      landingPath: "pricing",  // no leading slash
      firstSeenAt: new Date().toISOString(),
    });
    // Oracle: landingPath "only if starts with '/'"
    expect(result?.landingPath).toBeUndefined();
  });

  it("referringDomain: extracts hostname from full URL", () => {
    const result = sanitizeAttribution({
      referringDomain: "https://news.ycombinator.com/item?id=12345",
    });
    // Oracle: parsed to hostname only
    expect(result?.referringDomain).toBe("news.ycombinator.com");
  });

  it("referringDomain truncated to max 255 chars", () => {
    // A hostname longer than 255 chars is invalid per DNS, but we still test the guard
    const longDomain = "a".repeat(300) + ".com";
    const result = sanitizeAttribution({
      referringDomain: longDomain,
    });
    if (result?.referringDomain) {
      expect(result.referringDomain.length).toBeLessThanOrEqual(255);
    }
  });

  it("landingPath: strips URL fragment (#token), keeps pathname only", () => {
    const result = sanitizeAttribution({
      landingPath: "/x#token",
    });
    // Oracle: pathname only, no fragment
    expect(result?.landingPath).toBe("/x");
  });

  it("landingPath: strips both query string and fragment when both present", () => {
    const result = sanitizeAttribution({
      landingPath: "/reset?mode=verify#section",
    });
    // Oracle: pathname only, no query or fragment
    expect(result?.landingPath).toBe("/reset");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SCHEMA-SHAPE PIN: attribution subdoc has exactly the canonical fields
// Oracle: the canonical spec list below — derived from this task, not implementation
// Fails if any field is added, removed, renamed, or retyped in backend User schema.
// ───────────────────────────────────────────────────────────────────────────
describe("SCHEMA-SHAPE PIN: attribution subdoc fields (backend)", () => {
  const CANONICAL_FIELDS = [
    "source",
    "utmSource",
    "utmMedium",
    "utmCampaign",
    "utmContent",
    "utmTerm",
    "referringDomain",
    "landingPath",
    "firstSeenAt",
  ];

  it("attribution subdoc has exactly the canonical field set (no additions, no removals)", () => {
    const attrSchemaPath = User.schema.path("attribution") as any;
    const attrSchema = attrSchemaPath.schema;
    const actualFields = Object.keys(attrSchema.paths).filter((f) => f !== "_id");

    expect(actualFields.sort()).toEqual([...CANONICAL_FIELDS].sort());
  });

  it("attribution.source is String with enum [utm, referral, direct, unknown]", () => {
    const attrSchemaPath = User.schema.path("attribution") as any;
    const path = attrSchemaPath.schema.path("source") as any;
    expect(path.instance).toBe("String");
    expect([...path.options.enum].sort()).toEqual(
      ["direct", "referral", "unknown", "utm"]
    );
  });

  it("attribution.firstSeenAt is Date type", () => {
    const attrSchemaPath = User.schema.path("attribution") as any;
    const path = attrSchemaPath.schema.path("firstSeenAt") as any;
    expect(path.instance).toBe("Date");
  });

  it("attribution string fields are all String type", () => {
    const attrSchemaPath = User.schema.path("attribution") as any;
    const stringFields = [
      "utmSource",
      "utmMedium",
      "utmCampaign",
      "utmContent",
      "utmTerm",
      "referringDomain",
      "landingPath",
    ];
    for (const field of stringFields) {
      const path = attrSchemaPath.schema.path(field) as any;
      expect(path.instance).toBe("String");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T3.1: User.create failure — endpoint must NOT silently claim success
// Contract: when DB write throws, the endpoint surfaces an error and issues no token.
// ───────────────────────────────────────────────────────────────────────────
describe("T3.1: User.create failure contract", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("surfaces an error and does NOT return isNewUser:true or a token when User.create throws", async () => {
    // Simulate DB write failure on the new-user path
    jest.spyOn(User, "create" as any).mockRejectedValueOnce(new Error("DB write failed"));

    const res = await request(testApp)
      .post("/api/users/auth")
      .send({
        email: "t31-db-fail@example.com",
        password: "testpassword",
        attribution: { utmSource: "test" },
      });

    // Contract: a thrown User.create must NOT produce isNewUser:true or a token
    // An implementation that swallows the error and returns success would fail here
    expect(res.body.isNewUser).not.toBe(true);
    expect(res.body.token).toBeUndefined();
    // The endpoint must surface failure (4xx/5xx), not a 200 OK
    expect(res.status).toBeGreaterThanOrEqual(400);

    // No partial side effect: no user row persisted
    const user = await User.findOne({ email: "t31-db-fail@example.com" });
    expect(user).toBeNull();
  });
});
