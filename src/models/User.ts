import mongoose, { Document, Schema } from "mongoose";
import { AnsweredQuestion } from "../types/AnsweredQuestion";

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  resume: {
    skills: string[];
    experience: string[];
    education: string[];
    summary: string;
    certifications: string[]; // New field for certifications
    languages: string[]; // New field for languages
    projects: string[]; // New field for projects
    achievements: string[]; // New field for personal or professional achievements
    volunteerExperience: string[]; // New field for volunteer work
    interests: string[]; // New field for personal interests
  };
  preferences: {
    jobTypes: string[];
    location: string[];
    remoteOnly: boolean;
    minSalary: number;
    industries: string[];
    minScore: number;
    matchingEnabled: boolean;
  };
  skippedJobs: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
  isVerified: boolean; // New field for email verification status
  qna: AnsweredQuestion[];
  walletBalance: number; // Wallet balance in USD
  pendingEmail?: string;
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
  lastLoginAt?: Date;
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: false },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    resume: {
      skills: [String],
      experience: [String],
      education: [String],
      summary: String,
      certifications: [String], // Add certifications field
      languages: [String], // Add languages field
      projects: [String], // Add projects field
      achievements: [String], // Add achievements field
      volunteerExperience: [String], // Add volunteer experience field
      interests: [String], // Add interests field
    },
    preferences: {
      jobTypes: [String],
      location: [String],
      remoteOnly: { type: Boolean, default: false },
      minSalary: { type: Number, default: 0 },
      industries: [String],
      minScore: { type: Number, default: 30 },
      matchingEnabled: { type: Boolean, default: true },
    },
    skippedJobs: [{ type: Schema.Types.ObjectId, ref: "JobListing" }],
    isVerified: { type: Boolean, default: false },
    qna: [
      {
        questionId: { type: String, required: true },
        answer: { type: String, default: "" },
        mode: { type: String, enum: ["text", "voice"], default: "text" },
        skipped: { type: Boolean, default: false },
      },
    ],
    walletBalance: { type: Number, default: 0, min: 0 },
    pendingEmail: { type: String },
    emailVerificationToken: { type: String },
    emailVerificationExpires: { type: Date },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model<IUser>("User", UserSchema);
