import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../utils/connectDB";
import MatchRecord from "../models/MatchRecord";

async function backfillAppliedAt() {
  await connectDB();

  const records = await MatchRecord.find({ applied: true, appliedAt: null });
  console.log(`Found ${records.length} records with applied=true and missing appliedAt`);

  if (records.length === 0) {
    console.log("Nothing to backfill.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const ops = records.map((record) => ({
    updateOne: {
      filter: { _id: record._id },
      update: { $set: { appliedAt: record.updatedAt } },
    },
  }));

  const result = await MatchRecord.bulkWrite(ops);
  console.log(`Updated ${result.modifiedCount} records.`);
  console.log("Note: appliedAt values are approximate — derived from updatedAt, not actual application time.");

  await mongoose.disconnect();
  process.exit(0);
}

backfillAppliedAt().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
