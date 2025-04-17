import mongoose, { Document, Schema } from "mongoose";

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
  };
  skippedJobs: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
  isVerified: boolean; // New field for email verification status
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
    },
    skippedJobs: [{ type: Schema.Types.ObjectId, ref: "JobListing" }],
    isVerified: { type: Boolean, default: false }, // New field for email verification status
  },
  { timestamps: true }
);

export default mongoose.model<IUser>("User", UserSchema);
