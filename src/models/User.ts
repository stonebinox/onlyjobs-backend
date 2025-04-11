import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  resume: {
    skills: string[];
    experience: string[];
    education: string[];
    summary: string;
    // more fields will be added when we implement resume parsing
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
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    resume: {
      skills: [String],
      experience: [String],
      education: [String],
      summary: String,
    },
    preferences: {
      jobTypes: [String],
      location: [String],
      remoteOnly: { type: Boolean, default: false },
      minSalary: { type: Number, default: 0 },
      industries: [String],
    },
    skippedJobs: [{ type: Schema.Types.ObjectId, ref: 'JobListing' }],
  },
  { timestamps: true }
);

export default mongoose.model<IUser>('User', UserSchema);
