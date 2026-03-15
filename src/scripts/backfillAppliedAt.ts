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

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let recentCount = 0;
  let oldCount = 0;

  const ops = records.map((record) => {
    const appliedAt = record.updatedAt;
    const isOld = appliedAt < thirtyDaysAgo;
    if (isOld) {
      oldCount++;
    } else {
      recentCount++;
    }
    return {
      updateOne: {
        filter: { _id: record._id },
        update: isOld
          ? { $set: { appliedAt, followUpSentAt: appliedAt } }
          : { $set: { appliedAt } },
      },
    };
  });

  const result = await MatchRecord.bulkWrite(ops);
  console.log(`Updated ${result.modifiedCount} records.`);
  console.log(`  - ${recentCount} recent (last 30 days) — will receive follow-up emails`);
  console.log(`  - ${oldCount} older than 30 days — marked as already handled (followUpSentAt set)`);
  console.log("Note: appliedAt values are approximate — derived from updatedAt, not actual application time.");

  await mongoose.disconnect();
  process.exit(0);
}

backfillAppliedAt().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
