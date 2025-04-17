import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import cron from "node-cron";
import connectDB from "./utils/connectDB";
import userRoutes from "./routes/userRoutes";
import jobRoutes from "./routes/jobRoutes";
import devRoutes from "./routes/devRoutes";
import runDailyJobScraping from "./jobs/scrapeJobs";
import runDailyJobMatching from "./jobs/matchJobs";

// Load environment variables
dotenv.config();

// Connect to database
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/users", userRoutes);
app.use("/api/jobs", jobRoutes);

// Basic health check route
app.get("/healthcheck", (req, res) => {
  res.send("API is running...");
});

if (process.env.NODE_ENV !== "production") {
  app.use("/dev", devRoutes);
}

// Schedule cron jobs
// Run job scraping every day at 1:00 AM
cron.schedule("0 1 * * *", () => {
  runDailyJobScraping();
});

// Run job matching every day at 3:00 AM
// cron.schedule("0 3 * * *", () => {
//   runDailyJobMatching();
// });

// Error handler middleware
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error(err.stack);
    res.status(500).json({
      message: err.message || "Something went wrong!",
      stack: process.env.NODE_ENV === "production" ? "🥞" : err.stack,
    });
  }
);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
