// Mock posthog-node before importing the service so no network is attempted.
const mockCapture = jest.fn();
const mockShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock("posthog-node", () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: mockCapture,
    shutdown: mockShutdown,
  })),
}));

import {
  captureLifecycleEvent,
  deriveRegion,
  shutdownAnalytics,
  walletBalanceBand,
} from "../services/analyticsService";

const fakeUser = {
  _id: { toString: () => "user-smoke-123" },
  walletBalance: 5,
  currentLocation: "London",
};

describe("analyticsService smoke tests", () => {
  const savedKey = process.env.POSTHOG_KEY;

  beforeAll(() => {
    // Ensure the service initializes in no-op mode for this module instance.
    delete process.env.POSTHOG_KEY;
  });

  afterAll(() => {
    if (savedKey !== undefined) process.env.POSTHOG_KEY = savedKey;
  });

  describe("no-op when POSTHOG_KEY is unset", () => {
    it("captureLifecycleEvent does not throw", () => {
      expect(() =>
        captureLifecycleEvent(fakeUser, "email_verified")
      ).not.toThrow();
    });

    it("capture is never called (true no-op)", () => {
      mockCapture.mockClear();
      captureLifecycleEvent(fakeUser, "wallet_topup_completed");
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("shutdownAnalytics does not throw", async () => {
      await expect(shutdownAnalytics()).resolves.toBeUndefined();
    });
  });

  describe("deriveRegion", () => {
    it('"Bangalore, India" => India', () => {
      expect(deriveRegion("Bangalore, India")).toBe("India");
    });

    it('"London" => EMEA', () => {
      expect(deriveRegion("London")).toBe("EMEA");
    });

    it('"Indiana" => Other (not India)', () => {
      expect(deriveRegion("Indiana")).toBe("Other");
    });

    it('"" => unknown', () => {
      expect(deriveRegion("")).toBe("unknown");
    });

    it("null => unknown", () => {
      expect(deriveRegion(null)).toBe("unknown");
    });

    it("whitespace-only => unknown", () => {
      expect(deriveRegion("   ")).toBe("unknown");
    });
  });

  describe("walletBalanceBand", () => {
    it("0 => empty", () => expect(walletBalanceBand(0)).toBe("empty"));
    it("0.30 => low", () => expect(walletBalanceBand(0.3)).toBe("low"));
    it("1 => funded", () => expect(walletBalanceBand(1)).toBe("funded"));
    it("NaN => empty", () => expect(walletBalanceBand(NaN)).toBe("empty"));
    it("Infinity => empty", () => expect(walletBalanceBand(Infinity)).toBe("empty"));
    it("negative => empty", () => expect(walletBalanceBand(-1)).toBe("empty"));
    it("0.01 => below_daily", () => expect(walletBalanceBand(0.01)).toBe("below_daily"));
    it("0.5 => low", () => expect(walletBalanceBand(0.5)).toBe("low"));
  });
});
