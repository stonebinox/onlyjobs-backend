import mongoose from "mongoose";

import RejectionSignal, {
  IRejectionSignal,
  RejectionSignalAnalysisStatus,
  RejectionSignalDuration,
  RejectionSignalScope,
  RejectionSignalSource,
} from "../models/RejectionSignal";
import { IMatchRecord, RejectionReason } from "../models/MatchRecord";
import { IJobListing } from "../models/JobListing";
import { companyKey, roleKey } from "../utils/companyHistory";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_COOLDOWN_DAYS = 7;
const MAX_COOLDOWN_DAYS = 180;
const DEFAULT_COOLDOWN_DAYS = 30;
const OVERRIDE_WINDOW_DAYS = 45;
const OVERRIDE_MIN_OTHER_SIGNALS = 2;
const MAX_MATCHER_SIGNALS = 20;
const MAX_DETAILS_CHARS = 140;
const MAX_RATIONALE_CHARS = 300;
// Listing-specific reasons say nothing about the company as a whole
const LISTING_SPECIFIC_CATEGORIES = ["location", "salary", "job_inactive"];

const SCOPES: RejectionSignalScope[] = [
  "none",
  "company",
  "company_role",
  "role",
  "attribute",
];
const DURATIONS: RejectionSignalDuration[] = ["none", "temporary", "permanent"];

export interface SignalDecision {
  scope: RejectionSignalScope;
  attribute?: string;
  duration: RejectionSignalDuration;
  cooldownDays?: number;
  rationale?: string;
  analysisStatus: RejectionSignalAnalysisStatus;
}

export const FAILED_DECISION: SignalDecision = {
  scope: "none",
  duration: "none",
  analysisStatus: "failed",
};

export const SKIPPED_DECISION: SignalDecision = {
  scope: "none",
  duration: "none",
  analysisStatus: "skipped",
};

export interface SignalSummary {
  scope: RejectionSignalScope;
  company: string;
  duration: RejectionSignalDuration;
  blockedUntil: Date | null;
}

export const isRejectionBlockingEnabled = (): boolean =>
  process.env.REJECTION_BLOCKS_ENABLED === "true";

// Strictly validates the model's `signal` object. Anything off is a failed analysis (fail open).
export const parseSignalDecision = (raw: unknown): SignalDecision => {
  if (!raw || typeof raw !== "object") return FAILED_DECISION;
  const s = raw as Record<string, unknown>;

  if (!SCOPES.includes(s.scope as RejectionSignalScope)) return FAILED_DECISION;
  if (!DURATIONS.includes(s.duration as RejectionSignalDuration)) {
    return FAILED_DECISION;
  }
  const scope = s.scope as RejectionSignalScope;
  const duration = s.duration as RejectionSignalDuration;

  const rationale =
    typeof s.rationale === "string" && s.rationale.trim()
      ? s.rationale.trim().slice(0, MAX_RATIONALE_CHARS)
      : undefined;

  if (scope === "none") {
    if (duration !== "none") return FAILED_DECISION;
    return { scope, duration: "none", rationale, analysisStatus: "ok" };
  }
  if (duration === "none") return FAILED_DECISION;

  let attribute: string | undefined;
  if (scope === "attribute") {
    if (typeof s.attribute !== "string" || !s.attribute.trim()) {
      return FAILED_DECISION;
    }
    attribute = s.attribute.trim();
  }

  if (duration === "permanent") {
    return { scope, attribute, duration, rationale, analysisStatus: "ok" };
  }

  let cooldownDays = DEFAULT_COOLDOWN_DAYS;
  if (s.cooldownDays !== undefined && s.cooldownDays !== null) {
    if (typeof s.cooldownDays !== "number" || !Number.isFinite(s.cooldownDays)) {
      return FAILED_DECISION;
    }
    cooldownDays = Math.min(
      MAX_COOLDOWN_DAYS,
      Math.max(MIN_COOLDOWN_DAYS, Math.round(s.cooldownDays))
    );
  }
  return {
    scope,
    attribute,
    duration,
    cooldownDays,
    rationale,
    analysisStatus: "ok",
  };
};

const isListingSpecific = (category: string): boolean =>
  LISTING_SPECIFIC_CATEGORIES.includes(category);

// Repeated rejections of the same company are a company signal regardless of the model's scope choice
const applyRepeatRejectionOverride = async (
  userId: mongoose.Types.ObjectId,
  matchId: mongoose.Types.ObjectId,
  key: string,
  category: string,
  decision: SignalDecision
): Promise<SignalDecision> => {
  if (
    !key ||
    decision.analysisStatus !== "ok" ||
    isListingSpecific(category)
  ) {
    return decision;
  }
  const others = await RejectionSignal.countDocuments({
    userId,
    companyKey: key,
    status: "active",
    matchId: { $ne: matchId },
    category: { $nin: LISTING_SPECIFIC_CATEGORIES },
    // Expired temporary rows and failed-analysis rows are intentionally counted: a rejection inside
    // the window is an LLM-independent repeat signal regardless of cooldown. Only rows the AI
    // positively judged listing-specific (ok + scope none) are excluded.
    $nor: [{ analysisStatus: "ok", scope: "none" }],
    createdAt: { $gte: new Date(Date.now() - OVERRIDE_WINDOW_DAYS * DAY_MS) },
  });
  if (others < OVERRIDE_MIN_OTHER_SIGNALS) return decision;

  const forced: SignalDecision = { ...decision, scope: "company", attribute: undefined };
  if (decision.duration === "none") {
    forced.duration = "temporary";
    forced.cooldownDays = DEFAULT_COOLDOWN_DAYS;
  }
  return forced;
};

export const persistRejectionSignal = async (params: {
  match: IMatchRecord;
  job: IJobListing;
  source: RejectionSignalSource;
  reason: RejectionReason;
  decision: SignalDecision;
}): Promise<IRejectionSignal> => {
  const { match, job, source, reason } = params;
  const matchId = match._id as mongoose.Types.ObjectId;

  const existing = await RejectionSignal.findOne({ matchId, source });
  // Double-submit while active: keep the original row untouched
  if (existing && existing.status === "active") return existing;

  const key = companyKey(job.company);
  const decision = await applyRepeatRejectionOverride(
    match.userId,
    matchId,
    key,
    reason.category,
    params.decision
  );

  const temporary = decision.duration === "temporary";
  const fields = {
    userId: match.userId,
    matchId,
    jobId: match.jobId,
    source,
    category: reason.category,
    details: reason.details,
    company: job.company,
    companyKey: key,
    title: job.title,
    roleKey: roleKey(job.title),
    scope: decision.scope,
    attribute: decision.attribute,
    duration: decision.duration,
    cooldownDays: temporary ? decision.cooldownDays : undefined,
    blockedUntil: temporary
      ? new Date(
          Date.now() + (decision.cooldownDays ?? DEFAULT_COOLDOWN_DAYS) * DAY_MS
        )
      : null,
    rationale: decision.rationale,
    status: "active" as const,
    revokedAt: null,
    analysisStatus: decision.analysisStatus,
    analysisVersion: 1,
  };

  if (existing) {
    existing.set(fields);
    return existing.save();
  }
  try {
    return await RejectionSignal.create(fields);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const raced = await RejectionSignal.findOne({ matchId, source });
      if (raced) return raced;
    }
    throw err;
  }
};

export const toSignalSummary = (
  signal: Pick<
    IRejectionSignal,
    "scope" | "company" | "duration" | "blockedUntil" | "analysisStatus"
  >
): SignalSummary | null => {
  if (signal.scope === "none" || signal.analysisStatus !== "ok") return null;
  return {
    scope: signal.scope,
    company: signal.company,
    duration: signal.duration,
    blockedUntil: signal.blockedUntil ?? null,
  };
};

// Revokes this match's active signals (any scope) and also sweeps every other active
// company/company_role signal for the same (userId, companyKey). Nothing is revoked when the
// match has no active signal of its own. Returns the number of signals revoked.
export const revokeSignalsForMatch = async (
  userId: mongoose.Types.ObjectId | string,
  matchId: mongoose.Types.ObjectId | string
): Promise<number> => {
  const own = await RejectionSignal.find(
    { userId, matchId, status: "active" },
    { companyKey: 1, scope: 1 }
  ).lean();
  if (own.length === 0) return 0;

  const keys = [
    ...new Set(
      own.map((s) => s.companyKey).filter(Boolean)
    ),
  ];
  const result = await RejectionSignal.updateMany(
    {
      userId,
      status: "active",
      $or: [
        { matchId },
        { companyKey: { $in: keys }, scope: { $in: ["company", "company_role"] } },
      ],
    },
    { $set: { status: "revoked", revokedAt: new Date() } }
  );
  return result.modifiedCount;
};

export const deleteSignalsForUser = async (
  userId: mongoose.Types.ObjectId | string
): Promise<void> => {
  await RejectionSignal.deleteMany({ userId });
};

export interface ActiveRejectionSignal {
  _id: mongoose.Types.ObjectId;
  scope: RejectionSignalScope;
  attribute?: string;
  category: string;
  details?: string;
  company: string;
  companyKey: string;
  title: string;
  roleKey: string;
  duration: RejectionSignalDuration;
  blockedUntil?: Date | null;
}

export interface ActiveRejectionBlocks {
  companyBlocks: ActiveRejectionSignal[];
  contextSignals: ActiveRejectionSignal[];
}

export const getActiveRejectionBlocks = async (
  userId: mongoose.Types.ObjectId | string,
  now: Date = new Date()
): Promise<ActiveRejectionBlocks> => {
  const active = await RejectionSignal.find({
    userId,
    status: "active",
    analysisStatus: "ok",
    scope: { $in: ["company", "company_role", "role", "attribute"] },
    $or: [{ duration: "permanent" }, { blockedUntil: { $gt: now } }],
  })
    .sort({ createdAt: -1 })
    .lean<ActiveRejectionSignal[]>();

  const companyBlocks = active.filter(
    (s) => s.scope === "company" || s.scope === "company_role"
  );

  const seen = new Set<string>();
  const contextSignals: ActiveRejectionSignal[] = [];
  for (const s of active) {
    if (s.scope !== "role" && s.scope !== "attribute") continue;
    const dedupeKey =
      s.scope === "attribute"
        ? `attribute:${(s.attribute ?? "").toLowerCase()}`
        : `role:${s.roleKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    contextSignals.push(s);
    if (contextSignals.length === MAX_MATCHER_SIGNALS) break;
  }

  return { companyBlocks, contextSignals };
};

// The active block covering this job, preferring a permanent one, then the longest cooldown.
export const findBlockForJob = (
  blocks: ActiveRejectionSignal[],
  job: Pick<IJobListing, "company" | "title">
): ActiveRejectionSignal | undefined => {
  const key = companyKey(job.company);
  if (!key) return undefined;
  const jobRoleKey = roleKey(job.title);
  const matching = blocks.filter(
    (b) =>
      b.companyKey === key &&
      (b.scope === "company" ||
        (b.scope === "company_role" && b.roleKey === jobRoleKey))
  );
  const until = (b: ActiveRejectionSignal): number =>
    b.duration === "permanent"
      ? Infinity
      : (b.blockedUntil ? new Date(b.blockedUntil).getTime() : 0);
  return matching.sort((a, b) => until(b) - until(a))[0];
};

// Mirrored in backend and onlyjobs-background; keep identical.
export interface MatcherRejectionSignal {
  id: string;
  scope: "role" | "attribute";
  attribute?: string;
  role?: string;
  category: string;
  details?: string;
}

export const buildMatcherSignals = (
  signals: ActiveRejectionSignal[]
): MatcherRejectionSignal[] =>
  signals.map((s) => ({
    id: s._id.toString(),
    scope: s.scope as "role" | "attribute",
    ...(s.scope === "attribute" ? { attribute: s.attribute } : { role: s.title }),
    category: s.category,
    ...(s.details ? { details: s.details.slice(0, MAX_DETAILS_CHARS) } : {}),
  }));

const formatDate = (d: Date): string =>
  new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export interface RejectionEnforcement {
  matchScore: number;
  verdict: string | undefined;
  note: string | null;
}

// Caps the score below minScore (never raises it) when the job is blocked or the matcher
// reported it violates an explicit rejection signal. A positive verdict is downgraded to
// "Weak match" whenever the cap applies so score and verdict never disagree.
export const applyRejectionEnforcement = (params: {
  matchScore: number;
  verdict?: string;
  minScore: number;
  job: Pick<IJobListing, "company" | "title">;
  blocks: ActiveRejectionBlocks;
  violatedSignalIds?: string[];
}): RejectionEnforcement => {
  const { matchScore, verdict, minScore, job, blocks } = params;
  const block = findBlockForJob(blocks.companyBlocks, job);
  const violated = blocks.contextSignals.find((s) =>
    (params.violatedSignalIds ?? []).includes(s._id.toString())
  );
  if (!block && !violated) return { matchScore, verdict, note: null };

  const cap = Math.max(0, minScore - 1);
  const capped = Math.min(matchScore, cap);
  const cappedVerdict =
    verdict === "Strong match" || verdict === "Mild match" ? "Weak match" : verdict;
  if (block) {
    const name = block.scope === "company_role" ? `${block.title} roles at ${job.company}` : job.company;
    const when =
      block.duration === "permanent" || !block.blockedUntil
        ? "permanently"
        : `until ${formatDate(block.blockedUntil)}`;
    return { matchScore: capped, verdict: cappedVerdict, note: `You chose to hide ${name} ${when}.` };
  }
  const label = violated!.attribute || violated!.category;
  return {
    matchScore: capped,
    verdict: cappedVerdict,
    note: `This conflicts with a rejection you gave earlier: ${label}.`,
  };
};
