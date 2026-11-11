import MetaEventOutbox, { IMetaEventOutbox } from "../models/MetaEventOutbox";
import { getMetaCapiStartAt } from "../utils/metaEvents";

// Meta Conversions API drain. ONE event per Graph POST. Never logs the token, payloads,
// raw email or full URLs. Background only enqueues; it never calls Meta.

const LEASE_MS = 2 * 60 * 1000;
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 20;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 10_000;

export interface MetaWorkerConfig {
  pixelId: string;
  accessToken: string;
  graphApiVersion: string;
  testEventCode?: string;
}

// A8: when enabled, all of these are required; otherwise the worker does not start.
export function resolveMetaWorkerConfig():
  | { ok: true; config: MetaWorkerConfig }
  | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (!getMetaCapiStartAt()) missing.push("META_CAPI_START_AT");
  const graphApiVersion = process.env.META_GRAPH_API_VERSION;
  const versionOk = !!graphApiVersion && /^v\d+\.\d+$/.test(graphApiVersion);
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!versionOk) missing.push("META_GRAPH_API_VERSION");
  if (!pixelId) missing.push("META_PIXEL_ID");
  if (!accessToken) missing.push("META_CAPI_ACCESS_TOKEN");
  if (missing.length > 0 || !graphApiVersion || !pixelId || !accessToken) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    config: {
      pixelId,
      accessToken,
      graphApiVersion,
      testEventCode: process.env.META_TEST_EVENT_CODE || undefined,
    },
  };
}

export function buildGraphEvent(row: IMetaEventOutbox): Record<string, unknown> {
  const userData: Record<string, string> = {};
  const src = (row.userData ?? {}) as unknown as Record<string, unknown>;
  for (const key of ["em", "external_id", "client_ip_address", "client_user_agent", "fbc", "fbp"]) {
    const v = src[key];
    if (typeof v === "string" && v) userData[key] = v;
  }
  const event: Record<string, unknown> = {
    event_name: row.eventName,
    event_time: row.eventTime,
    event_id: row.eventId,
    action_source: "website",
    user_data: userData,
  };
  if (row.eventSourceUrl) event.event_source_url = row.eventSourceUrl;
  if (row.value !== undefined && row.value !== null) {
    event.custom_data = { value: row.value, currency: row.currency ?? "USD" };
  }
  return event;
}

type SendOutcome = "sent" | "transient" | "permanent" | "config";

async function sendEvent(row: IMetaEventOutbox, cfg: MetaWorkerConfig): Promise<SendOutcome> {
  const body: Record<string, unknown> = {
    data: [buildGraphEvent(row)],
    access_token: cfg.accessToken,
  };
  if (cfg.testEventCode) body.test_event_code = cfg.testEventCode;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let status: number;
  let parsed: Record<string, unknown> = {};
  try {
    const res = await fetch(
      `https://graph.facebook.com/${cfg.graphApiVersion}/${cfg.pixelId}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );
    status = res.status;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  } catch {
    return "transient"; // network error or timeout
  } finally {
    clearTimeout(timer);
  }

  if (status >= 200 && status < 300) {
    const received = typeof parsed.events_received === "number" ? parsed.events_received : 0;
    return received >= 1 ? "sent" : "transient";
  }
  if (status === 401 || status === 403) return "config";
  const errCode = (parsed.error as { code?: unknown } | undefined)?.code;
  if (errCode === 190) return "config"; // invalid / expired access token
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "transient";
  if (status === 400 || status === 422) return "permanent";
  return "transient";
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)), BACKOFF_MAX_MS);
}

// IP and user agent are scrubbed once a row reaches a terminal state.
const SCRUB = { "userData.client_ip_address": "", "userData.client_user_agent": "" };

async function markTerminal(
  row: IMetaEventOutbox,
  status: "sent" | "dead",
  category?: string
): Promise<void> {
  const now = new Date();
  await MetaEventOutbox.updateOne(
    { _id: row._id, status: "sending" },
    {
      $set: {
        status,
        leaseUntil: null,
        purgeAt: new Date(now.getTime() + PURGE_AFTER_MS),
        ...(status === "sent" ? { sentAt: now } : {}),
        ...(category ? { lastErrorCategory: category } : {}),
      },
      $unset: SCRUB,
    }
  );
}

export interface DrainSummary {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  configFailed: number;
  sentWithoutFbc: number;
}

let drainInFlight: Promise<DrainSummary> | null = null;

async function claimNext(): Promise<IMetaEventOutbox | null> {
  const now = new Date();
  return MetaEventOutbox.findOneAndUpdate(
    {
      $or: [
        { status: { $in: ["pending", "failed"] }, nextAttemptAt: { $lte: now } },
        { status: "sending", leaseUntil: { $lt: now } },
      ],
    },
    { $set: { status: "sending", leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, new: true }
  );
}

async function runDrain(cfg: MetaWorkerConfig, shouldStop: () => boolean): Promise<DrainSummary> {
  const summary: DrainSummary = { claimed: 0, sent: 0, retried: 0, dead: 0, configFailed: 0, sentWithoutFbc: 0 };

  for (let i = 0; i < BATCH_SIZE && !shouldStop(); i++) {
    const row = await claimNext();
    if (!row) break;
    summary.claimed++;

    if (row.attempts > MAX_ATTEMPTS) {
      await markTerminal(row, "dead", "max_attempts");
      summary.dead++;
      continue;
    }

    const outcome = await sendEvent(row, cfg);
    if (outcome === "sent") {
      if (!row.userData?.fbc) summary.sentWithoutFbc++;
      await markTerminal(row, "sent");
      summary.sent++;
    } else if (outcome === "permanent") {
      await markTerminal(row, "dead", "permanent_rejection");
      summary.dead++;
    } else if (outcome === "config") {
      // Leave the row pending (attempt not consumed) and stop the batch.
      await MetaEventOutbox.updateOne(
        { _id: row._id, status: "sending" },
        {
          $set: { status: "pending", leaseUntil: null, lastErrorCategory: "config" },
          $inc: { attempts: -1 },
        }
      );
      summary.configFailed++;
      console.error("[metaCapi] Meta rejected credentials (401/403/invalid token); stopping batch");
      break;
    } else if (row.attempts >= MAX_ATTEMPTS) {
      await markTerminal(row, "dead", "max_attempts");
      summary.dead++;
    } else {
      await MetaEventOutbox.updateOne(
        { _id: row._id, status: "sending" },
        {
          $set: {
            status: "failed",
            leaseUntil: null,
            lastErrorCategory: "transient",
            nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
          },
        }
      );
      summary.retried++;
    }
  }

  if (summary.sentWithoutFbc > 0) {
    console.log(`[metaCapi] ${summary.sentWithoutFbc} conversion(s) sent without fbc`);
  }
  return summary;
}

// Single-flight: a concurrent call joins the in-flight drain.
export function drainMetaEventOutbox(
  cfg: MetaWorkerConfig,
  shouldStop: () => boolean = () => false
): Promise<DrainSummary> {
  if (drainInFlight) return drainInFlight;
  drainInFlight = runDrain(cfg, shouldStop).finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

export function getInFlightDrain(): Promise<DrainSummary> | null {
  return drainInFlight;
}
