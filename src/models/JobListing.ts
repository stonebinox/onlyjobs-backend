import mongoose, { Document, Schema } from "mongoose";

export interface IJobListing extends Document {
  title: string;
  company: string;
  location: string;
  salary: {
    min: number;
    max: number;
    currency: string;
  };
  tags: string[];
  source: string;
  description: string;
  url: string;
  postedDate: Date;
  scrapedDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

const JobListingSchema: Schema = new Schema(
  {
    title: { type: String, required: true },
    company: { type: String, required: true },
    location: { type: String, required: true },
    salary: {
      min: Number,
      max: Number,
      currency: { type: String, default: "USD" },
    },
    tags: [String],
    source: { type: String, required: true },
    description: { type: String, required: true },
    url: { type: String, required: true },
    postedDate: Date,
    scrapedDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model<IJobListing>("JobListing", JobListingSchema);
