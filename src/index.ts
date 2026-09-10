import dotenv from "dotenv";

dotenv.config();

import connectDB from "./utils/connectDB";
import { shutdownAnalytics } from "./services/analyticsService";
import app from "./app";

connectDB();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received — flushing analytics and exiting`);
  await shutdownAnalytics();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
