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

let resendClient: Resend | null = null;

const ensureConfigured = () => {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    console.error("[EMAIL] Resend API key missing: set RESEND_API_KEY environment variable");
    return false;
  }

  if (!resendClient) {
    resendClient = new Resend(RESEND_API_KEY);
    console.log("[EMAIL] Resend client initialized");
  }
  return true;
};

export const sendInitialVerificationEmail = async (
  email: string,
  token: string
): Promise<boolean> => {
  console.log(`[EMAIL] Attempting to send initial verification email to ${email}`);

  if (!ensureConfigured()) {
    console.error(`[EMAIL] Skipping initial verification - Resend not configured`);
    return false;
  }

  if (!email) {
    console.error("[EMAIL] Skipping initial verification - email missing");
    return false;
  }

  const frontendUrl =
    process.env.FRONTEND_URL || process.env.APP_URL || "https://onlyjobs.app";
  const verifyUrl = `${frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;

  const subject = "Verify your email address for onlyjobs";
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937;">
      <h2 style="color:#111827;">Verify your email address</h2>
      <p>Welcome to onlyjobs! Please verify your email address to start receiving job matches.</p>
      <p>Click the button below to verify your email address.</p>
      <div style="margin-top:20px; text-align:center;">
        <a href="${verifyUrl}" style="display:inline-block; background-color:#111827; color:#ffffff; padding:12px 20px; text-decoration:none; border-radius:6px; font-weight:600;">Verify Email</a>
      </div>
      <p style="margin-top:16px; color:#6b7280; font-size:14px;">This link will expire in 24 hours and can be used only once.</p>
      <p style="margin-top:16px;">– The onlyjobs team</p>
    </div>
  `;

  try {
    if (!resendClient) {
      throw new Error("Resend client not initialized");
    }

    const FROM_EMAIL = process.env.RESEND_FROM || "onlyjobs <onboarding@resend.dev>";

    console.log(`[EMAIL] Sending initial verification email to ${email} from ${FROM_EMAIL}`);
    const result = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject,
      html,
    });

    console.log(
      `[EMAIL] ✓ Sent initial verification email to ${email} (ID: ${
        result.data?.id || "unknown"
      })`
    );
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(
      `[EMAIL] ✗ Failed to send initial verification email to ${email}:`,
      errorMessage
    );
    if (err && typeof err === "object" && "response" in err) {
      const response = (err as { response?: { body?: unknown } }).response;
      if (response?.body) {
        console.error(`[EMAIL] Resend error details:`, JSON.stringify(response.body, null, 2));
      }
    }
    return false;
  }
};

export const sendEmailChangeVerificationEmail = async (
  userEmail: string,
  newEmail: string,
  token: string
): Promise<boolean> => {
  console.log(`[EMAIL] Attempting to send email change verification to ${newEmail}`);

  if (!ensureConfigured()) {
    console.error(`[EMAIL] Skipping email change verification - Resend not configured`);
    return false;
  }

  if (!newEmail) {
    console.error("[EMAIL] Skipping email change verification - new email missing");
    return false;
  }

  const frontendUrl =
    process.env.FRONTEND_URL || process.env.APP_URL || "https://onlyjobs.app";
  const verifyUrl = `${frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;

  const subject = "Confirm your new email address for onlyjobs";
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937;">
      <h2 style="color:#111827;">Confirm your new email</h2>
      <p>We received a request to change your onlyjobs email from <strong>${userEmail}</strong> to <strong>${newEmail}</strong>.</p>
      <p>If this was you, click the button below to verify. If not, you can ignore this email.</p>
      <div style="margin-top:20px; text-align:center;">
        <a href="${verifyUrl}" style="display:inline-block; background-color:#111827; color:#ffffff; padding:12px 20px; text-decoration:none; border-radius:6px; font-weight:600;">Confirm New Email</a>
      </div>
      <p style="margin-top:16px; color:#6b7280; font-size:14px;">This link will expire soon and can be used only once.</p>
      <p style="margin-top:16px;">– The onlyjobs team</p>
    </div>
  `;

  try {
    if (!resendClient) {
      throw new Error("Resend client not initialized");
    }

    const FROM_EMAIL = process.env.RESEND_FROM || "onlyjobs <onboarding@resend.dev>";

    console.log(`[EMAIL] Sending email change verification to ${newEmail} from ${FROM_EMAIL}`);
    const result = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: newEmail,
      subject,
      html,
    });

    console.log(
      `[EMAIL] ✓ Sent email change verification to ${newEmail} (ID: ${
        result.data?.id || "unknown"
      })`
    );
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(
      `[EMAIL] ✗ Failed to send email change verification to ${newEmail}:`,
      errorMessage
    );
    if (err && typeof err === "object" && "response" in err) {
      const response = (err as { response?: { body?: unknown } }).response;
      if (response?.body) {
        console.error(`[EMAIL] Resend error details:`, JSON.stringify(response.body, null, 2));
      }
    }
    return false;
  }
};

export const sendMatchingEnabledEmail = async (user: IUser): Promise<boolean> => {
  console.log(`[EMAIL] Attempting to send matching enabled email to ${user.email}`);

  if (!ensureConfigured()) {
    console.error(`[EMAIL] Skipping matching enabled email - Resend not configured`);
    return false;
  }

  if (!user.email) {
    console.error(`[EMAIL] Skipping matching enabled email - user email missing`);
    return false;
  }

  const frontendUrl = process.env.FRONTEND_URL || process.env.APP_URL || "https://onlyjobs.app";
  const dashboardUrl = `${frontendUrl}/dashboard`;

  const subject = "Welcome back! Job matching is now active";
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937;">
      <h2 style="color:#111827;">Welcome back to job matching!</h2>
      <p>We've reactivated job matching for your account. Starting with the next matching run, we'll find opportunities that match your profile and preferences.</p>
      <p>When we find matches, we'll deduct $0.30 from your wallet and send you a summary email with the top opportunities.</p>
      <div style="margin-top:24px; text-align:center;">
        <a href="${dashboardUrl}" style="display:inline-block; background-color:#111827; color:#ffffff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:600;">View Dashboard</a>
      </div>
      <p style="margin-top:24px; color:#6b7280; font-size:14px;">You can pause matching anytime from your settings if needed.</p>
      <p style="margin-top:16px;">– The onlyjobs team</p>
    </div>
  `;

  try {
    if (!resendClient) {
      throw new Error("Resend client not initialized");
    }

    const FROM_EMAIL = process.env.RESEND_FROM || "onlyjobs <onboarding@resend.dev>";

    console.log(`[EMAIL] Sending matching enabled email to ${user.email} from ${FROM_EMAIL}`);
    const result = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: user.email,
      subject,
      html,
    });

    console.log(`[EMAIL] ✓ Successfully sent matching enabled email to ${user.email} (ID: ${result.data?.id || 'unknown'})`);
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[EMAIL] ✗ Failed to send matching enabled email to ${user.email}:`, errorMessage);
    if (err && typeof err === "object" && "response" in err) {
      const response = (err as { response?: { body?: unknown } }).response;
      if (response?.body) {
        console.error(`[EMAIL] Resend error details:`, JSON.stringify(response.body, null, 2));
      }
    }
    return false;
  }
};

export const sendMatchingDisabledEmail = async (user: IUser): Promise<boolean> => {
  console.log(`[EMAIL] Attempting to send matching disabled email to ${user.email}`);

  if (!ensureConfigured()) {
    console.error(`[EMAIL] Skipping matching disabled email - Resend not configured`);
    return false;
  }

  if (!user.email) {
    console.error(`[EMAIL] Skipping matching disabled email - user email missing`);
    return false;
  }

  const frontendUrl = process.env.FRONTEND_URL || process.env.APP_URL || "https://onlyjobs.app";
  const settingsUrl = `${frontendUrl}/settings`;

  const subject = "Job matching has been paused";
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937;">
      <h2 style="color:#111827;">Job matching paused</h2>
      <p>We've paused job matching for your account as requested. We won't run any matching or deduct from your wallet until you turn it back on.</p>
      <p>Your wallet balance remains unchanged, and you can resume matching anytime from your settings.</p>
      <div style="margin-top:24px; text-align:center;">
        <a href="${settingsUrl}" style="display:inline-block; background-color:#111827; color:#ffffff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:600;">Manage Settings</a>
      </div>
      <p style="margin-top:24px; color:#6b7280; font-size:14px;">When you're ready to resume, just toggle matching back on in your settings.</p>
      <p style="margin-top:16px;">– The onlyjobs team</p>
    </div>
  `;

  try {
    if (!resendClient) {
      throw new Error("Resend client not initialized");
    }

    const FROM_EMAIL = process.env.RESEND_FROM || "onlyjobs <onboarding@resend.dev>";

    console.log(`[EMAIL] Sending matching disabled email to ${user.email} from ${FROM_EMAIL}`);
    const result = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: user.email,
      subject,
      html,
    });

    console.log(`[EMAIL] ✓ Successfully sent matching disabled email to ${user.email} (ID: ${result.data?.id || 'unknown'})`);
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[EMAIL] ✗ Failed to send matching disabled email to ${user.email}:`, errorMessage);
    if (err && typeof err === "object" && "response" in err) {
      const response = (err as { response?: { body?: unknown } }).response;
      if (response?.body) {
        console.error(`[EMAIL] Resend error details:`, JSON.stringify(response.body, null, 2));
      }
    }
    return false;
  }
};

export const sendMatchSummaryEmail = async (
  user: IUser,
  matches: MatchSummaryItem[],
  chargeAmount: number
): Promise<boolean> => {
  console.log(`[EMAIL] Attempting to send match summary to ${user.email} with ${matches.length} matches`);
  
  if (!ensureConfigured()) {
    console.error(`[EMAIL] Skipping email to ${user.email} - Resend not configured`);
    return false;
  }
  
  if (!user.email) {
    console.error(`[EMAIL] Skipping email - user email missing for user ${user._id}`);
    return false;
  }

  if (!matches.length) {
    console.log(`[EMAIL] Skipping email to ${user.email} - no matches to send`);
    return false;
  }

  const sortedMatches = [...matches].sort((a, b) => b.matchScore - a.matchScore);
  // Show top 3 matches, or all matches if there are 3 or fewer
  const topMatches = sortedMatches.slice(0, 3);
  const remainingCount = matches.length - topMatches.length;

  const listItems = topMatches
    .map(
      (match) =>
        `<li><strong>${match.title}</strong> at ${match.company} — score ${Math.round(
          match.matchScore
        )}/100 (${match.freshness})</li>`
    )
    .join("");

  // Only show "more matches" text if there are actually more than what we're displaying
  const moreMatchesText = remainingCount > 0 
    ? `<p style="margin-top:12px;"><strong>Plus ${remainingCount} more match${remainingCount === 1 ? '' : 'es'} waiting for you in your dashboard!</strong></p>`
    : '';

  // Get frontend URL for dashboard link
  const frontendUrl = process.env.FRONTEND_URL || process.env.APP_URL || "https://onlyjobs.app";
  const dashboardUrl = `${frontendUrl}/dashboard`;

  const subject = `You have ${matches.length} new match${matches.length === 1 ? '' : 'es'} on onlyjobs`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937;">
      <h2 style="color:#111827;">Good news! We found ${matches.length} new match${matches.length === 1 ? '' : 'es'} for you</h2>
      <p>We ran your preferences and answers against new roles and found fresh opportunities.</p>
      <ul>${listItems}</ul>
      ${moreMatchesText}
      <p style="margin-top:12px;">We applied your daily matching fee of $${chargeAmount.toFixed(
        2
      )}. Your updated wallet balance is visible in your dashboard.</p>
      <div style="margin-top:24px; text-align:center;">
        <a href="${dashboardUrl}" style="display:inline-block; background-color:#111827; color:#ffffff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:600;">View Your Matches</a>
      </div>
      <p style="margin-top:24px; color:#6b7280; font-size:14px;">Jump back in to review details, save your favorites, or skip roles you're not interested in.</p>
      <p style="margin-top:16px;">– The onlyjobs team</p>
    </div>
  `;

  try {
    if (!resendClient) {
      throw new Error("Resend client not initialized");
    }

    const FROM_EMAIL = process.env.RESEND_FROM || "onlyjobs <onboarding@resend.dev>";

    console.log(`[EMAIL] Sending email to ${user.email} from ${FROM_EMAIL}`);
    const result = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: user.email,
      subject,
      html,
    });
    
    console.log(`[EMAIL] ✓ Successfully sent match summary email to ${user.email} (ID: ${result.data?.id || 'unknown'})`);
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[EMAIL] ✗ Failed to send match summary email to ${user.email}:`, errorMessage);
    if (err && typeof err === "object" && "response" in err) {
      const response = (err as { response?: { body?: unknown } }).response;
      if (response?.body) {
        console.error(`[EMAIL] Resend error details:`, JSON.stringify(response.body, null, 2));
      }
    }
    return false;
  }
};
