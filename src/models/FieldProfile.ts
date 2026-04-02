import mongoose, { Document, Schema } from "mongoose";

export interface IFieldProfile extends Document {
  field: string;
  topSkills: { name: string; prevalence: number }[];
  commonPreferences: {
    remoteOnlyPercent: number;
    avgMinSalary: number;
    topLocations: string[];
  };
  sampleSize: number;
  updatedAt: Date;
}

const FieldProfileSchema: Schema = new Schema(
  {
    field: { type: String, required: true, unique: true },
    topSkills: [
      {
        name: { type: String, required: true },
        prevalence: { type: Number, required: true },
      },
    ],
    commonPreferences: {
      remoteOnlyPercent: { type: Number, required: true },
      avgMinSalary: { type: Number, required: true },
      topLocations: [String],
    },
    sampleSize: { type: Number, required: true },
  },
  { timestamps: true }
);

export default mongoose.model<IFieldProfile>("FieldProfile", FieldProfileSchema);
