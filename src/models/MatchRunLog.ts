import mongoose, { Document, Schema } from "mongoose";

export enum MatchRunOutcome {
  MATCHED = "matched",
  NO_MATCH = "no_match",
  SKIPPED_NO_RESUME = "skipped_no_resume",
  SKIPPED_DISABLED = "skipped_disabled",
  SKIPPED_INSUFFICIENT_BALANCE = "skipped_insufficient_balance",
  SKIPPED_NO_JOBS = "skipped_no_jobs",
  RUN_FAILED_PARTIAL = "run_failed_partial",
}

export interface IMatchRunLog extends Document {
  userId: mongoose.Types.ObjectId;
  runAt: Date;
  outcome: string;
  totalJobsAvailable: number;
  totalNewJobs: number;
  preFilterResults: {
    remoteOnlySkipped: number;
    salarySkipped: number;
    locationSkipped: number;
    relevanceSkipped: number;
  };
  jobsEvaluated: number;
  matchesCreated: number;
  autoSkipped: number;
  reasonCode: string;
  reasonSummary: string;
  createdAt: Date;
}

const MatchRunLogSchema: Schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    runAt: { type: Date, required: true },
    outcome: {
      type: String,
      enum: Object.values(MatchRunOutcome),
      required: true,
    },
    totalJobsAvailable: { type: Number, default: 0 },
    totalNewJobs: { type: Number, default: 0 },
    preFilterResults: {
      remoteOnlySkipped: { type: Number, default: 0 },
      salarySkipped: { type: Number, default: 0 },
      locationSkipped: { type: Number, default: 0 },
      relevanceSkipped: { type: Number, default: 0 },
    },
    jobsEvaluated: { type: Number, default: 0 },
    matchesCreated: { type: Number, default: 0 },
    autoSkipped: { type: Number, default: 0 },
    reasonCode: { type: String, required: true },
    reasonSummary: { type: String, required: true },
  },
  { timestamps: true }
);

MatchRunLogSchema.index({ userId: 1, runAt: 1 });

export default mongoose.model<IMatchRunLog>("MatchRunLog", MatchRunLogSchema);
