import mongoose, { Document, Schema } from "mongoose";

// onlyjobs-6a4p: this file MUST stay byte-identical to the copy in the other repo
// (backend/ and onlyjobs-background/). Both write the same MongoDB collection.

export type MetaEventName = "CompleteRegistration" | "Activated" | "Purchase";
export type MetaEventStatus = "pending" | "sending" | "sent" | "failed" | "dead";

// Stored under Meta's own field names. The runtime allow-list in utils/metaEvents.ts
// drops any other key before a row is written.
export interface IMetaUserData {
  em?: string;
  external_id?: string;
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
}

export interface IMetaEventOutbox extends Document {
  eventId: string;
  eventName: MetaEventName;
  eventTime: number; // unix SECONDS
  userId: mongoose.Types.ObjectId;
  value?: number;
  currency?: string;
  eventSourceUrl?: string;
  userData: IMetaUserData;
  status: MetaEventStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil?: Date | null;
  lastErrorCategory?: string;
  sentAt?: Date;
  purgeAt: Date;
}

const MetaEventOutboxSchema: Schema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    eventName: {
      type: String,
      enum: ["CompleteRegistration", "Activated", "Purchase"],
      required: true,
    },
    eventTime: { type: Number, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    value: { type: Number },
    currency: { type: String },
    eventSourceUrl: { type: String },
    userData: {
      type: {
        em: String,
        external_id: String,
        client_ip_address: String,
        client_user_agent: String,
        fbc: String,
        fbp: String,
      },
      default: {},
      _id: false,
    },
    status: {
      type: String,
      enum: ["pending", "sending", "sent", "failed", "dead"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseUntil: { type: Date, default: null },
    lastErrorCategory: { type: String },
    sentAt: { type: Date },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true }
);

MetaEventOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
MetaEventOutboxSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IMetaEventOutbox>("MetaEventOutbox", MetaEventOutboxSchema);
