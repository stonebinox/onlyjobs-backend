import mongoose, { Document, Schema } from "mongoose";

export interface IJobListing extends Document {
  title: string;
  company: string;
  location: string[];
  salary: {
    min: number;
    max: number;
    currency: string;
    estimated?: boolean;
  };
  tags: string[];
  source: string;
  description: string;
  url: string;
  sourceUrl?: string; // Original URL from the source (e.g., WWR URL before resolution)
  dedupKey: string; // Normalized url (trim+lowercase) of the final persisted url; unique-indexed
  postedDate: Date;
  scrapedDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Normalized dedup key: trim+lowercase of the final persisted url. No query-string stripping,
// trailing-slash normalization, or redirect resolution — only trim+lowercase.
export function computeDedupKey(url: string): string {
  return url.trim().toLowerCase();
}

const JobListingSchema: Schema = new Schema(
  {
    title: { type: String, required: true },
    company: { type: String, required: true },
    location: { type: [String], required: true },
    salary: {
      min: Number,
      max: Number,
      estimated: { type: Boolean, default: false },
      currency: { type: String, default: "USD" },
    },
    tags: [String],
    source: { type: String, required: true },
    description: { type: String, required: true },
    url: { type: String, required: true },
    sourceUrl: { type: String }, // Original URL from source before resolution (optional)
    dedupKey: { type: String }, // Every insert MUST set this via computeDedupKey(url); the unique index is on dedupKey, not url
    postedDate: Date,
    scrapedDate: { type: Date, default: Date.now },
  },
  // autoIndex: false — deploying this schema must NOT auto-attempt to build the unique dedupKey
  // index, which would fail against pre-existing duplicate rows. The index is built explicitly
  // by scripts/migrate-joblisting-dedupkey.mjs after duplicate reconciliation.
  { timestamps: true, autoIndex: false }
);

// Unique index on dedupKey. Built by migration after duplicate reconciliation, not auto-built.
JobListingSchema.index({ dedupKey: 1 }, { unique: true, partialFilterExpression: { dedupKey: { $type: "string", $gt: "" } } });

// Belt-and-suspenders: if a caller omits dedupKey (e.g. a future insert path), derive it from url
// before persisting.  The unique partial index is the enforcer; this hook is the invariant guard.
// Covers .save() and .create() — insertMany/bulkWrite bypass hooks (confirmed: no such paths exist).
JobListingSchema.pre<IJobListing>("save", function (next) {
  if ((!this.dedupKey || this.dedupKey === "") && typeof this.url === "string" && this.url !== "") {
    this.dedupKey = computeDedupKey(this.url);
  }
  next();
});

export default mongoose.model<IJobListing>("JobListing", JobListingSchema);
