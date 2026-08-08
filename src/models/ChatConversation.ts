import mongoose, { Document, Schema } from "mongoose";

export interface IChatConversation extends Document {
  userId: mongoose.Types.ObjectId;
  title: string;
  contextType: "general" | "job";
  contextMatchId?: mongoose.Types.ObjectId;
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
    contextType: { type: String, enum: ["general", "job"], default: "general" },
    contextMatchId: { type: Schema.Types.ObjectId, ref: "MatchRecord" },
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
// One job conversation per user per match — partial so general conversations are unaffected
ChatConversationSchema.index(
  { userId: 1, contextType: 1, contextMatchId: 1 },
  { unique: true, partialFilterExpression: { contextType: "job" } }
);

export default mongoose.model<IChatConversation>("ChatConversation", ChatConversationSchema);
