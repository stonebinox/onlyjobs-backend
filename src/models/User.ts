import mongoose, { Document, Schema } from "mongoose";
import { AnsweredQuestion } from "../types/AnsweredQuestion";

export interface LearnedPreferences {
  insights: string; // AI-generated summary for matching prompt
  lastUpdated: Date;
  feedbackCount: number; // how many "No" reasons contributed
}

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  id: string;
  name: string;
  email: string;
  password: string;
  phone?: string;
  resume: {
    skills: string[];
    experience: (string | { text: string; link?: string })[];
    education: string[];
    summary: string;
    certifications: string[]; // New field for certifications
    languages: string[]; // New field for languages
    projects: (string | { text: string; link?: string })[]; // New field for projects
    achievements: string[]; // New field for personal or professional achievements
    volunteerExperience: string[]; // New field for volunteer work
    interests: string[]; // New field for personal interests
  };
  socialLinks?: {
    linkedin?: string;
    github?: string;
    portfolio?: string;
    twitter?: string;
    website?: string;
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
  learnedPreferences?: LearnedPreferences;
  skippedJobs: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
  isVerified: boolean; // New field for email verification status
  qna: AnsweredQuestion[];
  walletBalance: number; // Wallet balance in USD
  pendingEmail?: string;
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  lastLoginAt?: Date;
  guideProgress?: Map<
    string,
    {
      completed: boolean;
      completedAt?: Date;
      skipped: boolean;
      skippedAt?: Date;
    }
  >;
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: false },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    phone: { type: String, required: false },
    resume: {
      skills: [String],
      experience: [Schema.Types.Mixed], // Support both string and { text: string, link?: string }
      education: [String],
      summary: String,
      certifications: [String], // Add certifications field
      languages: [String], // Add languages field
      projects: [Schema.Types.Mixed], // Support both string and { text: string, link?: string }
      achievements: [String], // Add achievements field
      volunteerExperience: [String], // Add volunteer experience field
      interests: [String], // Add interests field
    },
    socialLinks: {
      linkedin: { type: String },
      github: { type: String },
      portfolio: { type: String },
      twitter: { type: String },
      website: { type: String },
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
    learnedPreferences: {
      type: {
        insights: { type: String, required: true },
        lastUpdated: { type: Date, required: true },
        feedbackCount: { type: Number, required: true, default: 0 },
      },
      default: undefined,
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
    passwordResetToken: { type: String },
    passwordResetExpires: { type: Date },
    lastLoginAt: { type: Date },
    guideProgress: {
      type: Map,
      of: {
        completed: { type: Boolean, default: false },
        completedAt: { type: Date },
        skipped: { type: Boolean, default: false },
        skippedAt: { type: Date },
      },
      default: {},
    },
  },
  { timestamps: true }
);

export default mongoose.model<IUser>("User", UserSchema);
