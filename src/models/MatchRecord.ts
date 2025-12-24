import mongoose, { Document, Schema } from "mongoose";

export enum Freshness {
  FRESH = "Fresh",
  WARM = "Warm",
  STALE = "Stale",
}

export interface MatchQnA {
  question: string;
  answer: string;
  createdAt: Date;
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
  applied: boolean | null;
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
    applied: { type: Boolean, default: null },
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

export default mongoose.model<IMatchRecord>("MatchRecord", MatchRecordSchema);
