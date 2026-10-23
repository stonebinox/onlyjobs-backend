import mongoose from "mongoose";

import MatchRecord, { IMatchRecord, RejectionReason } from "../models/MatchRecord";
import JobListing, { IJobListing } from "../models/JobListing";
import RejectionSignal, { RejectionSignalSource } from "../models/RejectionSignal";
import User, { IUser } from "../models/User";
import { extractRejectionSignal } from "../services/preferenceLearningService";
import {
  PendingRejection,
  SKIPPED_DECISION,
  SignalDecision,
  applyRepeatRejectionOverride,
  computeBlockedUntil,
  persistRejectionSignal,
} from "../services/rejectionSignalService";
import { companyKey } from "../utils/companyHistory";

// Excluded from the backfill entirely: no row written, not counted as a candidate
const NON_LEARNING_CATEGORY = "job_inactive";
// Rough gpt-4o-mini cost of one extraction call (~1.5k tokens in, ~300 out)
const EST_COST_PER_CALL_USD = 0.0005;
const MAX_DETAILS_PRINTED = 60;

export interface BackfillOptions {
  apply: boolean;
  yes: boolean;
  userEmail?: string;
  limit?: number;
  log?: (line: string) => void;
}

export interface BackfillResult {
  rows: number;
  plannedLlmCalls: number;
  llmCalls: number;
  estimatedCostUsd: number;
  created: number;
  errors: number;
  activeCompanyBlocksByUser: Record<string, number>;
}

interface Candidate {
  match: IMatchRecord;
  source: RejectionSignalSource;
  reason: RejectionReason;
  at: Date;
}

const needsLlm = (job: IJobListing | undefined): boolean => !!job;

const collectCandidates = async (
  userId: mongoose.Types.ObjectId | undefined
): Promise<Candidate[]> => {
  const scope = userId ? { userId } : {};
  const [skipped, notApplied] = await Promise.all([
    MatchRecord.find({
      ...scope,
      skipped: true,
      "skipReason.category": { $exists: true, $nin: [null, "", NON_LEARNING_CATEGORY] },
      verdict: { $ne: "skipped" },
    }),
    MatchRecord.find({
      ...scope,
      applied: false,
      "notAppliedReason.category": { $exists: true, $nin: [null, "", NON_LEARNING_CATEGORY] },
    }),
  ]);

  const now = Date.now();
  const all: Candidate[] = [
    ...skipped.map((match) => ({ match, source: "skip" as const, reason: match.skipReason! })),
    ...notApplied.map((match) => ({
      match,
      source: "not_applied" as const,
      reason: match.notAppliedReason!,
    })),
  ].map((c) => ({
    ...c,
    // updatedAt is the best available rejection time; never let it sit in the future
    at: new Date(Math.min(c.match.updatedAt.getTime(), now)),
  }));
  if (all.length === 0) return [];

  const existing = await RejectionSignal.find(
    { matchId: { $in: all.map((c) => c.match._id) } },
    { matchId: 1, source: 1 }
  ).lean();
  const done = new Set(existing.map((e) => `${e.matchId}:${e.source}`));

  return all.filter((c) => !done.has(`${c.match._id}:${c.source}`));
};

// Chronological per user, so the repeat-rejection override sees each user's earlier rows
const orderCandidates = (candidates: Candidate[]): Candidate[] => {
  const firstSeen = new Map<string, number>();
  for (const c of [...candidates].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const k = c.match.userId.toString();
    if (!firstSeen.has(k)) firstSeen.set(k, firstSeen.size);
  }
  return [...candidates].sort(
    (a, b) =>
      firstSeen.get(a.match.userId.toString())! - firstSeen.get(b.match.userId.toString())! ||
      a.at.getTime() - b.at.getTime()
  );
};

const isActiveAt = (decision: SignalDecision, blockedUntil: Date | null, now: Date): boolean =>
  decision.analysisStatus === "ok" &&
  decision.scope !== "none" &&
  (decision.duration === "permanent" || (!!blockedUntil && blockedUntil > now));

export const runBackfill = async (options: BackfillOptions): Promise<BackfillResult> => {
  const log = options.log ?? console.log;
  const result: BackfillResult = {
    rows: 0,
    plannedLlmCalls: 0,
    llmCalls: 0,
    estimatedCostUsd: 0,
    created: 0,
    errors: 0,
    activeCompanyBlocksByUser: {},
  };

  let userId: mongoose.Types.ObjectId | undefined;
  if (options.userEmail) {
    const u = await User.findOne({ email: options.userEmail.toLowerCase() }, { _id: 1 });
    if (!u) {
      log(`No user with email ${options.userEmail}`);
      return result;
    }
    userId = u._id as mongoose.Types.ObjectId;
  }

  let candidates = orderCandidates(await collectCandidates(userId));
  if (options.limit !== undefined) candidates = candidates.slice(0, options.limit);
  result.rows = candidates.length;

  const jobs = new Map<string, IJobListing>(
    (await JobListing.find({ _id: { $in: candidates.map((c) => c.match.jobId) } })).map((j) => [
      String(j._id),
      j,
    ])
  );
  result.plannedLlmCalls = candidates.filter((c) =>
    needsLlm(jobs.get(String(c.match.jobId)))
  ).length;

  log(`Rejections to backfill: ${result.rows}`);
  log(
    `Planned LLM calls: ${result.plannedLlmCalls} (est. $${(
      result.plannedLlmCalls * EST_COST_PER_CALL_USD
    ).toFixed(4)})`
  );
  log(`Mode: ${options.apply ? "APPLY (writes RejectionSignals)" : "DRY RUN (no writes)"}`);
  if (!options.yes) {
    log("Counts only. Re-run with --yes to make the LLM calls and show decisions.");
    return result;
  }

  const users = new Map<string, IUser | null>();
  const pending: PendingRejection[] = [];
  const nowRun = new Date();
  const activeBlocks = new Map<string, Set<string>>();

  for (const c of candidates) {
    const uid = c.match.userId.toString();
    if (!users.has(uid)) users.set(uid, await User.findById(c.match.userId));
    const user = users.get(uid);
    const job = jobs.get(String(c.match.jobId));
    if (!user) {
      result.errors++;
      log(`SKIP ${uid} ${c.source}: user not found`);
      continue;
    }

    try {
      let decision: SignalDecision;
      if (!job) {
        decision = SKIPPED_DECISION;
      } else {
        result.llmCalls++;
        const extracted = await extractRejectionSignal(user, job, c.match, c.reason);
        if (!extracted || extracted.analysisStatus !== "ok") {
          // Leave no row so a re-run retries this one
          result.errors++;
          log(`FAIL ${user.email} ${job.company} / ${job.title}: extraction failed, not recorded`);
          continue;
        }
        decision = extracted;
      }

      let finalDecision = decision;
      let blockedUntil: Date | null = null;
      if (!job) {
        if (options.apply) {
          await RejectionSignal.create({
            userId: c.match.userId,
            matchId: c.match._id,
            jobId: c.match.jobId,
            source: c.source,
            category: c.reason.category,
            details: c.reason.details,
            scope: "none",
            duration: "none",
            status: "active",
            revokedAt: null,
            analysisStatus: "skipped",
            analysisVersion: 1,
            createdAt: c.at,
          });
        }
      } else if (options.apply) {
        const saved = await persistRejectionSignal({
          match: c.match,
          job,
          source: c.source,
          reason: c.reason,
          decision,
          now: c.at,
        });
        finalDecision = {
          scope: saved.scope,
          attribute: saved.attribute,
          duration: saved.duration,
          cooldownDays: saved.cooldownDays,
          analysisStatus: saved.analysisStatus,
        };
        blockedUntil = saved.blockedUntil ?? null;
      } else {
        finalDecision = await applyRepeatRejectionOverride(
          c.match.userId,
          c.match._id as mongoose.Types.ObjectId,
          companyKey(job.company),
          c.reason.category,
          decision,
          c.at,
          pending
        );
        blockedUntil = computeBlockedUntil(finalDecision, c.at);
        pending.push({
          userId: c.match.userId,
          companyKey: companyKey(job.company),
          category: c.reason.category,
          createdAt: c.at,
          analysisStatus: finalDecision.analysisStatus,
          scope: finalDecision.scope,
        });
      }
      if (options.apply) result.created++;

      const active = isActiveAt(finalDecision, blockedUntil, nowRun);
      if (active && (finalDecision.scope === "company" || finalDecision.scope === "company_role")) {
        const set = activeBlocks.get(user.email) ?? new Set<string>();
        set.add(job ? companyKey(job.company) : "");
        activeBlocks.set(user.email, set);
      }

      const details = (c.reason.details ?? "").replace(/\s+/g, " ").slice(0, MAX_DETAILS_PRINTED);
      log(
        [
          user.email,
          c.at.toISOString().slice(0, 10),
          job ? `${job.company} / ${job.title}` : "(listing deleted)",
          c.source,
          c.reason.category,
          details ? `"${details}"` : "-",
          `-> scope=${finalDecision.scope}`,
          `duration=${finalDecision.duration}`,
          `blockedUntil=${blockedUntil ? blockedUntil.toISOString().slice(0, 10) : "-"}`,
          active ? "ACTIVE" : "inactive",
        ].join(" | ")
      );
    } catch (err) {
      result.errors++;
      log(`ERROR ${user.email} match ${c.match._id}: ${(err as Error).message}`);
    }
  }

  result.estimatedCostUsd = result.llmCalls * EST_COST_PER_CALL_USD;
  for (const [email, set] of activeBlocks) result.activeCompanyBlocksByUser[email] = set.size;

  log("--- Summary ---");
  log(`Rows: ${result.rows}`);
  log(`LLM calls made: ${result.llmCalls}`);
  log(`Estimated cost: $${result.estimatedCostUsd.toFixed(4)}`);
  log(`Signals written: ${result.created}${options.apply ? "" : " (dry run)"}`);
  log(`Errors/unrecorded: ${result.errors}`);
  log("Active company blocks per user:");
  const entries = Object.entries(result.activeCompanyBlocksByUser);
  if (entries.length === 0) log("  (none)");
  for (const [email, n] of entries) log(`  ${email}: ${n}`);
  return result;
};

const parseArgs = (argv: string[]): BackfillOptions => {
  const opts: BackfillOptions = {
    apply: argv.includes("--apply"),
    yes: argv.includes("--yes"),
  };
  const userIdx = argv.indexOf("--user");
  if (userIdx !== -1) opts.userEmail = argv[userIdx + 1];
  const limitIdx = argv.indexOf("--limit");
  if (limitIdx !== -1) {
    const n = Number(argv[limitIdx + 1]);
    if (!Number.isInteger(n) || n < 0) throw new Error("--limit needs a non-negative integer");
    opts.limit = n;
  }
  if (userIdx !== -1 && !opts.userEmail) throw new Error("--user needs an email");
  return opts;
};

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  // Loaded lazily so importing runBackfill (tests) never reads .env
  (await import("dotenv")).config();
  const { default: connectDB } = await import("../utils/connectDB");
  await connectDB();
  await runBackfill(opts);
  await mongoose.disconnect();
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Backfill failed:", err);
      process.exit(1);
    });
}
