import mongoose, { Document, Schema } from "mongoose";

export interface IChatConversation extends Document {
  userId: mongoose.Types.ObjectId;
  title: string;
  messages: {
    role: "user" | "assistant";
    content: string;
    createdAt: Date;
  }[];
  summary?: string;
  summaryUpToIndex?: number;
  createdAt: Date;
  updatedAt: Date;
}

const ChatConversationSchema: Schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, default: "" },
    messages: {
      type: [
        {
          role: { type: String, enum: ["user", "assistant"], required: true },
          content: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    summary: { type: String },
    summaryUpToIndex: { type: Number },
  },
  { timestamps: true }
);

ChatConversationSchema.index({ userId: 1 });

export default mongoose.model<IChatConversation>("ChatConversation", ChatConversationSchema);
