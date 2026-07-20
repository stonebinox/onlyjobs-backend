import mongoose from "mongoose";

const BASE_DELAY = 1000;
const CAP_DELAY = 60000;

// Register event listeners once at module load for runtime visibility
mongoose.connection.on("connected", () => {
  console.log("[DB] MongoDB connected");
});
mongoose.connection.on("disconnected", () => {
  console.log("[DB] MongoDB disconnected");
});
mongoose.connection.on("reconnected", () => {
  console.log("[DB] MongoDB reconnected");
});
mongoose.connection.on("error", (err) => {
  console.error("[DB] MongoDB error:", err.message);
});

const connectDB = async (): Promise<void> => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[DB] FATAL: MONGO_URI environment variable is not set");
    process.exit(1);
    return; // only reached in tests where process.exit is mocked
  }

  // Guard against concurrent or re-entrant connects
  const { readyState } = mongoose.connection;
  if (readyState === 1 || readyState === 2) {
    return;
  }

  let attempt = 0;
  let connected = false;
  while (!connected) {
    try {
      const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      console.log(`[DB] MongoDB Connected: ${conn.connection.host}`);
      connected = true;
    } catch (err: any) {
      const backoff = Math.min(CAP_DELAY, BASE_DELAY * Math.pow(2, attempt));
      const jitter = Math.floor(Math.random() * 1000);
      const delay = backoff + jitter;
      console.error(
        `[DB] Connection attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms`
      );
      attempt++;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
};

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export default connectDB;
