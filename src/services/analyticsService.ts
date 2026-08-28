import { PostHog } from "posthog-node";

export type LifecycleEvent =
  | "wallet_topup_completed"
  | "email_verified"
  | "on_demand_match";

// Minimal structural type — only the fields this service accesses.
// A lean Mongoose document or full IUser both satisfy this.
interface AnalyticsUser {
  _id: { toString(): string };
  walletBalance?: number | null;
  currentLocation?: string | null;
}

// Lazy singleton — null means "no POSTHOG_KEY configured"
let _client: PostHog | null = null;
let _initialized = false;

function getClient(): PostHog | null {
  if (_initialized) return _client;
  _initialized = true;
  const key = process.env.POSTHOG_KEY;
  if (!key) return null;
  const host = process.env.POSTHOG_HOST ?? "https://app.posthog.com";
  try {
    _client = new PostHog(key, { host });
  } catch {
    _client = null;
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Region derivation — pure, deterministic, no PII emitted
// ---------------------------------------------------------------------------

type Region = "US" | "EMEA" | "India" | "APAC" | "Other" | "unknown";

// Each entry may be a single word or a space-separated phrase.
// When an alias has spaces it is matched by checking whether those tokens
// appear consecutively in the tokenized input (so "Indiana" never matches
// "India", and "Hong Kong" matches ["hong","kong"] as a consecutive pair).
//
// Precedence when multiple buckets match: India > US > EMEA > APAC.
// Documented here because it is a deliberate tie-break, not an accident.
const INDIA_ALIASES = [
  "india", "bharat", "bengaluru", "bangalore", "mumbai", "delhi",
  "hyderabad", "chennai", "pune", "kolkata", "gurgaon", "noida",
];
const US_ALIASES = [
  "usa", "us", "america", "u.s.", "u.s.a", "united states",
];
const EMEA_ALIASES = [
  "uk", "united kingdom", "england", "london", "ireland", "germany",
  "france", "spain", "netherlands", "poland", "portugal", "italy",
  "sweden", "europe", "eu", "uae", "dubai", "africa", "nigeria",
  "kenya", "egypt", "southafrica", "south africa",
];
const APAC_ALIASES = [
  "singapore", "australia", "sydney", "melbourne", "japan", "tokyo",
  "china", "shanghai", "hongkong", "hong kong", "philippines", "manila",
  "indonesia", "jakarta", "vietnam", "malaysia", "thailand", "newzealand",
  "new zealand", "korea", "apac", "asia",
];

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function matchesAliases(tokens: string[], aliases: string[]): boolean {
  for (const alias of aliases) {
    const aliasTokens = tokenize(alias);
    if (aliasTokens.length === 1) {
      if (tokens.includes(aliasTokens[0])) return true;
    } else {
      // Check for the alias token sequence appearing consecutively in input
      outer: for (let i = 0; i <= tokens.length - aliasTokens.length; i++) {
        for (let j = 0; j < aliasTokens.length; j++) {
          if (tokens[i + j] !== aliasTokens[j]) continue outer;
        }
        return true;
      }
    }
  }
  return false;
}

export const deriveRegion = (currentLocation?: string | null): Region => {
  if (
    !currentLocation ||
    typeof currentLocation !== "string" ||
    !currentLocation.trim()
  ) {
    return "unknown";
  }
  const tokens = tokenize(currentLocation);
  if (tokens.length === 0) return "unknown";

  // Precedence: India > US > EMEA > APAC
  if (matchesAliases(tokens, INDIA_ALIASES)) return "India";
  if (matchesAliases(tokens, US_ALIASES)) return "US";
  if (matchesAliases(tokens, EMEA_ALIASES)) return "EMEA";
  if (matchesAliases(tokens, APAC_ALIASES)) return "APAC";
  return "Other";
};

// ---------------------------------------------------------------------------
// Wallet balance band — pure, deterministic
// ---------------------------------------------------------------------------

export const walletBalanceBand = (
  balance: number
): "empty" | "below_daily" | "low" | "funded" => {
  if (!isFinite(balance) || balance <= 0) return "empty";
  if (balance < 0.3) return "below_daily";
  if (balance < 1) return "low";
  return "funded";
};

// ---------------------------------------------------------------------------
// Event capture — synchronous fire-and-forget, NEVER throws into caller
// ---------------------------------------------------------------------------

export const captureLifecycleEvent = (
  user: AnalyticsUser,
  event: LifecycleEvent
): void => {
  try {
    const client = getClient();
    if (!client) return;
    client.capture({
      distinctId: user._id.toString(),
      event,
      properties: {
        $set: {
          wallet_balance_band: walletBalanceBand(user.walletBalance ?? 0),
          region: deriveRegion(user.currentLocation),
        },
      },
    });
  } catch (err) {
    console.error("[analytics] captureLifecycleEvent failed:", err);
  }
};

// ---------------------------------------------------------------------------
// Graceful shutdown — flush batched events before process exit
// ---------------------------------------------------------------------------

export const shutdownAnalytics = async (): Promise<void> => {
  try {
    const client = getClient();
    if (client) await client.shutdown();
  } catch (err) {
    console.error("[analytics] shutdown failed:", err);
  }
};
