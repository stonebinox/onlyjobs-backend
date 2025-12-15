import { Resend } from "resend";

import { IUser } from "../models/User";
import { Freshness } from "../models/MatchRecord";

export interface MatchSummaryItem {
  title: string;
  company: string;
  url?: string;
  matchScore: number;
  freshness: Freshness;
}

const FROM_EMAIL = process.env.RESEND_FROM || "onlyjobs <onboarding@resend.dev>";
const RESEND_API_KEY = process.env.RESEND_API_KEY;

let resendClient: Resend | null = null;

const ensureConfigured = () => {
  if (!RESEND_API_KEY) {
    console.error("Resend API key missing: set RESEND_API_KEY");
    return false;
  }

  if (!resendClient) {
    resendClient = new Resend(RESEND_API_KEY);
  }
  return true;
};

export const sendMatchSummaryEmail = async (
  user: IUser,
  matches: MatchSummaryItem[],
  chargeAmount: number
): Promise<boolean> => {
  if (!ensureConfigured()) return false;
  if (!user.email) {
    console.error("Cannot send email: user email missing");
    return false;
  }

  if (!matches.length) {
    console.log(`No matches to email for user ${user.email}`);
    return false;
  }

  const topMatches = [...matches]
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);

  const listItems = topMatches
    .map(
      (match) =>
        `<li><strong>${match.title}</strong> at ${match.company} — score ${Math.round(
          match.matchScore
        )}/100 (${match.freshness})${match.url ? ` — <a href="${match.url}">View</a>` : ""}</li>`
    )
    .join("");

  const subject = `You have ${matches.length} new matches on onlyjobs`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937;">
      <h2 style="color:#111827;">Good news! We found ${matches.length} new matches for you</h2>
      <p>We ran your preferences and answers against new roles and found fresh opportunities.</p>
      <ul>${listItems}</ul>
      <p style="margin-top:12px;">We applied your daily matching fee of $${chargeAmount.toFixed(
        2
      )}. Your updated wallet balance is visible in your dashboard.</p>
      <p style="margin-top:12px;">Jump back in to review details, save your favorites, or skip roles you’re not interested in.</p>
      <p style="margin-top:16px;">– The onlyjobs team</p>
    </div>
  `;

  try {
    if (!resendClient) {
      throw new Error("Resend client not initialized");
    }

    await resendClient.emails.send({
      from: FROM_EMAIL,
      to: user.email,
      subject,
      html,
    });
    console.log(`Sent match summary email to ${user.email}`);
    return true;
  } catch (err) {
    console.error("Failed to send match summary email", err);
    return false;
  }
};
