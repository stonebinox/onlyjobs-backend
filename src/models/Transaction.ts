import mongoose, { Document, Schema } from "mongoose";

export interface ITransaction extends Document {
  userId: mongoose.Types.ObjectId;
  type: "credit" | "debit";
  amount: number;
  description: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  metadata?: Record<string, any>;
  status: "pending" | "completed" | "failed";
  timestamp: Date;
  chargeKey?: string;
}

const TransactionSchema: Schema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      required: true,
    },
    razorpayOrderId: {
      type: String,
      sparse: true,
    },
    razorpayPaymentId: {
      type: String,
      sparse: true,
    },
    razorpaySignature: {
      type: String,
      sparse: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "completed",
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    // Idempotency key for the nightly matching fee: `daily:<userId>:<YYYY-MM-DD UTC>`.
    // Only set on daily-fee claim rows; never written as null.
    chargeKey: {
      type: String,
    },
  },
  { timestamps: true }
);

// Compound index for efficient queries
TransactionSchema.index({ userId: 1, timestamp: -1 });

// Unique only where chargeKey is a string, so pre-existing rows (no chargeKey) never collide and
// the index builds without a dedupe. Prevents a second daily-fee claim for the same user/day.
TransactionSchema.index(
  { chargeKey: 1 },
  { unique: true, partialFilterExpression: { chargeKey: { $type: "string" } } }
);

export default mongoose.model<ITransaction>("Transaction", TransactionSchema);

