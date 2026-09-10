import express from "express";
import dotenv from "dotenv";
import cors from "cors";

import { isDbConnected } from "./utils/connectDB";
import { errorHandler } from "./middleware/errorHandler";
import userRoutes from "./routes/userRoutes";
import jobRoutes from "./routes/jobRoutes";
import matchRoutes from "./routes/matchRoutes";
import walletRoutes from "./routes/walletRoutes";
import chatRoutes from "./routes/chatRoutes";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

const allowedOrigin = process.env.FRONTEND_URL;
if (process.env.NODE_ENV === "production" && !allowedOrigin) {
  console.warn("WARNING: FRONTEND_URL is not set — CORS is open in production");
}
app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? allowedOrigin || true
    : true,
  credentials: true,
}));

app.use(
  express.json({
    limit: "10mb",
    type: (req) => {
      return req.headers["content-type"]?.startsWith("application/json");
    },
    verify: (req, _res, buf) => {
      if (typeof req.url === "string" && req.url.includes("/wallet/webhook")) {
        (req as any).rawBody = buf;
      }
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/api/users", userRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/matches", matchRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/chat", chatRoutes);

app.get("/healthcheck", (req, res) => {
  res.json({
    status: "ok",
    service: "backend",
    db: isDbConnected() ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

app.use(errorHandler);

export default app;
