const mockSend = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

import { IUser } from "../models/User";
import { sendMatchSummaryEmail, sendMatchingEnabledEmail, MatchSummaryItem } from "../services/emailService";
import { Freshness } from "../models/MatchRecord";

const FRONTEND_URL = "https://onlyjobs.app";

const testUser = (): IUser =>
  ({
    _id: "user1",
    email: "test@example.com",
  } as unknown as IUser);

const match = (): MatchSummaryItem => ({
  title: "Software Engineer",
  company: "Acme",
  matchScore: 85,
  freshness: Freshness.FRESH,
});

describe("sendMatchSummaryEmail - CTA href", () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrontendUrl = process.env.FRONTEND_URL;

  beforeAll(() => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.FRONTEND_URL = FRONTEND_URL;
  });

  afterAll(() => {
    process.env.RESEND_API_KEY = originalApiKey;
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: "email-ms" }, error: null });
  });

  it("CTA href is /today and not /dashboard", async () => {
    await sendMatchSummaryEmail(testUser(), [match()], 0.3);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const html: string = mockSend.mock.calls[0][0].html;
    expect(html).toContain(`${FRONTEND_URL}/today`);
    expect(html).not.toContain(`${FRONTEND_URL}/dashboard`);
    expect(html).not.toContain("/dashboard");
  });
});

describe("sendMatchingEnabledEmail - CTA href", () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrontendUrl = process.env.FRONTEND_URL;

  beforeAll(() => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.FRONTEND_URL = FRONTEND_URL;
  });

  afterAll(() => {
    process.env.RESEND_API_KEY = originalApiKey;
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: "email-me" }, error: null });
  });

  it("CTA href is /today and not /dashboard", async () => {
    await sendMatchingEnabledEmail(testUser());
    expect(mockSend).toHaveBeenCalledTimes(1);
    const html: string = mockSend.mock.calls[0][0].html;
    expect(html).toContain(`${FRONTEND_URL}/today`);
    expect(html).not.toContain(`${FRONTEND_URL}/dashboard`);
    expect(html).not.toContain("/dashboard");
  });

  it("CTA label is 'View Your Matches' not 'View Dashboard'", async () => {
    await sendMatchingEnabledEmail(testUser());
    const html: string = mockSend.mock.calls[0][0].html;
    expect(html).toContain("View Your Matches");
    expect(html).not.toContain("View Dashboard");
  });
});
