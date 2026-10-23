import mongoose, { Document, Schema } from "mongoose";

export type RejectionSignalSource = "skip" | "not_applied";
export type RejectionSignalScope =
  | "none"
  | "company"
  | "company_role"
  | "role"
  | "attribute";
export type RejectionSignalDuration = "none" | "temporary" | "permanent";
export type RejectionSignalStatus = "active" | "revoked";
export type RejectionSignalAnalysisStatus = "ok" | "failed" | "skipped";

export interface IRejectionSignal extends Document {
  userId: mongoose.Types.ObjectId;
  matchId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  source: RejectionSignalSource;
  category: string;
  details?: string;
  company: string;
  companyKey: string;
  title: string;
  roleKey: string;
  scope: RejectionSignalScope;
  attribute?: string;
  duration: RejectionSignalDuration;
  cooldownDays?: number;
  blockedUntil?: Date | null;
  rationale?: string;
  status: RejectionSignalStatus;
  revokedAt?: Date | null;
  analysisStatus: RejectionSignalAnalysisStatus;
  analysisVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const RejectionSignalSchema: Schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    matchId: { type: Schema.Types.ObjectId, ref: "MatchRecord", required: true },
    jobId: { type: Schema.Types.ObjectId, ref: "JobListing", required: true },
    source: { type: String, enum: ["skip", "not_applied"], required: true },
    category: { type: String, required: true },
    details: { type: String },
    company: { type: String, default: "" },
    companyKey: { type: String, default: "" },
    title: { type: String, default: "" },
    roleKey: { type: String, default: "" },
    scope: {
      type: String,
      enum: ["none", "company", "company_role", "role", "attribute"],
      default: "none",
    },
    attribute: { type: String },
    duration: {
      type: String,
      enum: ["none", "temporary", "permanent"],
      default: "none",
    },
    cooldownDays: { type: Number },
    blockedUntil: { type: Date, default: null },
    rationale: { type: String },
    status: { type: String, enum: ["active", "revoked"], default: "active" },
    revokedAt: { type: Date, default: null },
    analysisStatus: {
      type: String,
      enum: ["ok", "failed", "skipped"],
      required: true,
    },
    analysisVersion: { type: Number, default: 1 },
  },
  { timestamps: true }
);

RejectionSignalSchema.index({ matchId: 1, source: 1 }, { unique: true });
RejectionSignalSchema.index({ userId: 1, companyKey: 1, status: 1 });

export default mongoose.model<IRejectionSignal>(
  "RejectionSignal",
  RejectionSignalSchema
);
