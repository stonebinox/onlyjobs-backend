import mongoose, { Document, Schema } from "mongoose";

export enum Freshness {
  FRESH = "Fresh",
  WARM = "Warm",
  STALE = "Stale",
}

export enum ApplicationOutcome {
  HEARD_BACK = "heard_back",
  NO_RESPONSE = "no_response",
  REJECTED = "rejected",
  INTERVIEW = "interview",
  OFFER = "offer",
}

export interface MatchQnA {
  _id?: mongoose.Types.ObjectId;
  question: string;
  answer: string;
  createdAt: Date;
}

// Reusable type for both skip and not-applied reasons
export interface RejectionReason {
  category: string; // e.g., "salary", "location", "skills_gap", "company_type", "role_mismatch", "job_inactive", "other"
  details?: string; // optional free text from user
  analyzedAt?: Date; // when the AI analyzed this reason
}

export interface IMatchRecord extends Document {
  userId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  matchScore: number;
  verdict: string;
  reasoning: string;
  freshness: Freshness;
  clicked: boolean;
  createdAt: Date;
  updatedAt: Date;
  skipped: boolean;
  skipReason?: RejectionReason;
  applied: boolean | null;
  appliedAt?: Date | null;
  followUpSentAt?: Date | null;
  applicationOutcome?: string | null;
  outcomeRecordedAt?: Date | null;
  notAppliedReason?: RejectionReason;
  qna?: MatchQnA[];
}

const MatchRecordSchema: Schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    jobId: { type: Schema.Types.ObjectId, ref: "JobListing", required: true },
    matchScore: { type: Number, required: true, min: 0, max: 100 },
    verdict: { type: String, required: true },
    reasoning: { type: String, required: true },
    freshness: {
      type: String,
      enum: Object.values(Freshness),
      default: Freshness.FRESH,
    },
    clicked: { type: Boolean, default: false },
    skipped: { type: Boolean, default: false },
    skipReason: {
      type: {
        category: { type: String, required: true },
        details: { type: String },
        analyzedAt: { type: Date },
      },
      default: undefined,
    },
    applied: { type: Boolean, default: null },
    appliedAt: { type: Date, default: undefined },
    followUpSentAt: { type: Date, default: undefined },
    applicationOutcome: { type: String, enum: Object.values(ApplicationOutcome), default: undefined },
    outcomeRecordedAt: { type: Date, default: undefined },
    notAppliedReason: {
      type: {
        category: { type: String, required: true },
        details: { type: String },
        analyzedAt: { type: Date },
      },
      default: undefined,
    },
    qna: {
      type: [
        {
          question: { type: String, required: true },
          answer: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

// Ensure unique matches between users and jobs
MatchRecordSchema.index({ userId: 1, jobId: 1 }, { unique: true });
MatchRecordSchema.index({ applied: 1, appliedAt: 1, followUpSentAt: 1, userId: 1 });

export default mongoose.model<IMatchRecord>("MatchRecord", MatchRecordSchema);
