import mongoose, { Document, Schema } from "mongoose";

export interface IChatMemory extends Document {
  userId: mongoose.Types.ObjectId;
  entries: {
    key: string;
    value: string;
    source: string;
    createdAt: Date;
    updatedAt: Date;
  }[];
  updatedAt: Date;
}

const ChatMemorySchema: Schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    entries: {
      type: [
        {
          key: { type: String, required: true },
          value: { type: String, required: true },
          source: { type: String },
          createdAt: { type: Date, default: Date.now },
          updatedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

ChatMemorySchema.index({ userId: 1 }, { unique: true });

export default mongoose.model<IChatMemory>("ChatMemory", ChatMemorySchema);
