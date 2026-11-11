import { createHash } from "crypto";
import mongoose from "mongoose";
import MetaEventOutbox, { IMetaUserData, MetaEventName } from "../models/MetaEventOutbox";

// onlyjobs-6a4p: this file MUST stay byte-identical to the copy in the other repo
// (backend/ and onlyjobs-background/). Background only enqueues; the drain worker
// that talks to Meta lives in backend/ only.

const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FBCLID = 512;
// fbc/fbp are "fb.1.<ms>.<fbclid>": long enough for a 512-char fbclid plus prefix.
const MAX_CLICK_COOKIE = 600;
const MAX_UA = 512;
const CLICK_FIELD_RE = /^[A-Za-z0-9._-]+$/;

const USER_DATA_ALLOW_LIST: ReadonlyArray<keyof IMetaUserData> = [
  "em",
  "external_id",
  "client_ip_address",
  "client_user_agent",
  "fbc",
  "fbp",
];

// ---------------------------------------------------------------------------
// Config gate
// ---------------------------------------------------------------------------

export function getMetaCapiStartAt(): Date | null {
  const raw = process.env.META_CAPI_START_AT;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// Enqueue only when explicitly enabled AND a valid start date is configured.
export function isMetaEnqueueEnabled(): boolean {
  return process.env.META_CAPI_ENABLED === "true" && getMetaCapiStartAt() !== null;
}

// An event whose time precedes META_CAPI_START_AT must never be enqueued (no backfill).
export function isBeforeMetaStart(eventTime: Date): boolean {
  const startAt = getMetaCapiStartAt();
  return !startAt || eventTime < startAt;
}

export function getSiteUrl(): string | undefined {
  const raw = process.env.SITE_URL || process.env.FRONTEND_URL;
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

export const regEventId = (userId: unknown): string => `reg_${String(userId)}`;
export const actEventId = (userId: unknown): string => `act_${String(userId)}`;
export const purchaseEventId = (transactionId: unknown): string => `purchase_${String(transactionId)}`;

export const toUnixSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

// ---------------------------------------------------------------------------
// Hashing + user_data allow-list
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashEmail(email: string): string | undefined {
  const normalized = email.normalize("NFKC").trim().toLowerCase();
  return normalized ? sha256Hex(normalized) : undefined;
}

// Meta click fields (fbclid / fbc / fbp): a validated string or undefined.
function cleanClickField(v: unknown, requirePrefix?: string): string | undefined {
  if (typeof v !== "string") return undefined;
  const max = requirePrefix ? MAX_CLICK_COOKIE : MAX_FBCLID;
  if (v.length === 0 || v.length > max) return undefined;
  if (!CLICK_FIELD_RE.test(v)) return undefined;
  if (requirePrefix && !v.startsWith(requirePrefix)) return undefined;
  return v;
}

export interface MetaClick {
  fbclid?: string;
  fbc?: string;
  fbp?: string;
}

// Rebuilds field-by-field; unknown keys are dropped. Returns undefined when nothing valid.
export function sanitizeMetaClick(raw: unknown): MetaClick | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: MetaClick = {};
  const fbclid = cleanClickField(r["fbclid"]);
  const fbc = cleanClickField(r["fbc"], "fb.1.");
  const fbp = cleanClickField(r["fbp"], "fb.1.");
  if (fbclid) out.fbclid = fbclid;
  if (fbc) out.fbc = fbc;
  if (fbp) out.fbp = fbp;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface MetaUserContext {
  userId: unknown;
  email?: string | null;
  ip?: string | null;
  ua?: string | null;
  fbc?: string | null;
  fbp?: string | null;
}

// Only Meta-named allow-listed keys can come out. em and external_id are SHA-256 hashed;
// fbc, fbp, IP and user agent are passed raw per Meta spec. Empty values are omitted.
export function buildMetaUserData(ctx: MetaUserContext): IMetaUserData {
  const out: IMetaUserData = {};
  if (ctx.email) {
    const em = hashEmail(ctx.email);
    if (em) out.em = em;
  }
  if (ctx.userId !== undefined && ctx.userId !== null && String(ctx.userId)) {
    out.external_id = sha256Hex(String(ctx.userId));
  }
  if (ctx.ip) out.client_ip_address = ctx.ip;
  if (ctx.ua) out.client_user_agent = ctx.ua.slice(0, MAX_UA);
  const fbc = cleanClickField(ctx.fbc ?? undefined, "fb.1.");
  const fbp = cleanClickField(ctx.fbp ?? undefined, "fb.1.");
  if (fbc) out.fbc = fbc;
  if (fbp) out.fbp = fbp;
  return out;
}

function pickAllowedUserData(raw: IMetaUserData): IMetaUserData {
  const out: Record<string, string> = {};
  const src = raw as Record<string, unknown>;
  for (const key of USER_DATA_ALLOW_LIST) {
    const v = src[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out as IMetaUserData;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  eventId: string;
  eventName: MetaEventName;
  eventTime: number;
  userId: unknown;
  value?: number;
  currency?: string;
  eventSourceUrl?: string;
  userData: IMetaUserData;
}

// Idempotent on eventId: a duplicate returns false. Throws on any other error.
// Returns false (enqueues nothing) when disabled or when the event predates META_CAPI_START_AT.
export async function enqueueMetaEvent(input: EnqueueInput): Promise<boolean> {
  const startAt = getMetaCapiStartAt();
  if (process.env.META_CAPI_ENABLED !== "true" || !startAt) return false;
  if (input.eventTime < Math.floor(startAt.getTime() / 1000)) return false;
  try {
    await MetaEventOutbox.create({
      eventId: input.eventId,
      eventName: input.eventName,
      eventTime: input.eventTime,
      userId: new mongoose.Types.ObjectId(String(input.userId)),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.eventSourceUrl ? { eventSourceUrl: input.eventSourceUrl } : {}),
      userData: pickAllowedUserData(input.userData),
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      purgeAt: new Date(Date.now() + PURGE_AFTER_MS),
    });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

interface AttributionLike {
  attribution?: { fbc?: string | null; fbp?: string | null } | null;
}

interface RequestContext {
  ip?: string | null;
  ua?: string | null;
}

async function safely(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Never log payloads, emails or tokens: message only.
    console.error(`[meta] enqueue ${label} failed:`, err instanceof Error ? err.message : "unknown");
  }
}

function pageUrl(path: string): string | undefined {
  const site = getSiteUrl();
  return site ? `${site}${path}` : undefined;
}

// Best-effort: never throws, never fails the business action.
export async function enqueueCompleteRegistration(
  user: { _id: unknown; email?: string | null; createdAt?: Date } & AttributionLike,
  ctx: RequestContext = {}
): Promise<void> {
  if (!isMetaEnqueueEnabled()) return;
  if (isBeforeMetaStart(user.createdAt ?? new Date())) return;
  await safely("CompleteRegistration", () =>
    enqueueMetaEvent({
      eventId: regEventId(user._id),
      eventName: "CompleteRegistration",
      eventTime: toUnixSeconds(user.createdAt ?? new Date()),
      userId: user._id,
      eventSourceUrl: pageUrl("/"),
      userData: buildMetaUserData({
        userId: user._id,
        email: user.email,
        ip: ctx.ip,
        ua: ctx.ua,
        fbc: user.attribution?.fbc,
        fbp: user.attribution?.fbp,
      }),
    })
  );
}

// A1: only users created at/after META_CAPI_START_AT are eligible.
export async function enqueueActivated(
  user: { _id: unknown; email?: string | null; createdAt?: Date } & AttributionLike,
  activatedAt: Date,
  ctx: RequestContext = {}
): Promise<void> {
  if (!isMetaEnqueueEnabled()) return;
  const startAt = getMetaCapiStartAt() as Date;
  if (!user.createdAt || user.createdAt < startAt || isBeforeMetaStart(activatedAt)) return;
  await safely("Activated", () =>
    enqueueMetaEvent({
      eventId: actEventId(user._id),
      eventName: "Activated",
      eventTime: toUnixSeconds(activatedAt),
      userId: user._id,
      eventSourceUrl: pageUrl("/today"),
      userData: buildMetaUserData({
        userId: user._id,
        email: user.email,
        ip: ctx.ip,
        ua: ctx.ua,
        fbc: user.attribution?.fbc,
        fbp: user.attribution?.fbp,
      }),
    })
  );
}

interface TransactionMetadata {
  walletCredited?: boolean;
  walletCreditedAt?: Date | string;
  clientIp?: string;
  clientUa?: string;
  fbc?: string;
  fbp?: string;
}

interface TransactionLike {
  _id: unknown;
  userId: unknown;
  amount: number;
  metadata?: TransactionMetadata;
}

// Purchase for a credited Razorpay top-up. userData fallback chain per field:
// transaction metadata (captured at order creation) -> user.attribution -> omitted.
export async function enqueuePurchase(
  txn: TransactionLike,
  user: { email?: string | null } & AttributionLike
): Promise<void> {
  if (!isMetaEnqueueEnabled()) return;
  const meta = txn.metadata ?? {};
  const creditedAt = meta.walletCreditedAt ? new Date(meta.walletCreditedAt) : new Date();
  if (isBeforeMetaStart(creditedAt)) return;
  await safely("Purchase", () =>
    enqueueMetaEvent({
      eventId: purchaseEventId(txn._id),
      eventName: "Purchase",
      eventTime: toUnixSeconds(creditedAt),
      userId: txn.userId,
      value: txn.amount,
      currency: "USD",
      eventSourceUrl: pageUrl("/wallet"),
      userData: buildMetaUserData({
        userId: txn.userId,
        email: user.email,
        ip: meta.clientIp,
        ua: meta.clientUa,
        fbc: meta.fbc || user.attribution?.fbc,
        fbp: meta.fbp || user.attribution?.fbp,
      }),
    })
  );
}

// Fields the browser needs to fire a deduplicated Purchase. Present only when the
// transaction is completed AND the wallet credit actually happened.
export function purchaseClientFields(txn: {
  _id: unknown;
  amount: number;
  status?: string;
  metadata?: TransactionMetadata;
}): { metaEventId?: string; value?: number; currency?: string } {
  if (txn.status !== "completed" || txn.metadata?.walletCredited !== true) return {};
  return { metaEventId: purchaseEventId(txn._id), value: txn.amount, currency: "USD" };
}
