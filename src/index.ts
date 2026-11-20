import dotenv from "dotenv";

dotenv.config();

import connectDB from "./utils/connectDB";
import { shutdownAnalytics } from "./services/analyticsService";
import { startMetaDrainWorker, stopMetaDrainWorker } from "./services/metaDrainWorker";
import Transaction from "./models/Transaction";
import app from "./app";

// Build the unique partial chargeKey index (daily-fee idempotency) once the DB is up, and log it.
connectDB()
  .then(() => Transaction.createIndexes())
  .then(() => console.log("[BOOT] Transaction indexes ensured"))
  .catch((err) => console.error("[BOOT] ERROR: failed to create Transaction indexes:", err));
startMetaDrainWorker();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received — flushing analytics and exiting`);
  await stopMetaDrainWorker();
  await shutdownAnalytics();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
