import pLimit from "p-limit";

import User from "../models/User";
import JobListing, { IJobListing } from "../models/JobListing";
import MatchRecord, { Freshness } from "../models/MatchRecord";
import Transaction from "../models/Transaction";
import { matchUserToJob, UserQnAData } from "../services/matchingService";
import { getUserQnA } from "../services/userService";
import {
  MatchSummaryItem,
  sendMatchSummaryEmail,
} from "../services/emailService";
import { filterJobsForUser } from "../utils/filterJobsForUser";

// Concurrency limit for parallel OpenAI calls (10 = ~10x speedup)
const MATCHING_CONCURRENCY = 10;

interface JobMatchResult {
  job: IJobListing;
  matchScore: number;
  verdict: string;
  reasoning: string;
  freshness: Freshness;
}

export async function runDailyJobMatching(userId?: string): Promise<void> {
  console.log("Starting daily job matching task...");
  console.time("Job matching");

  try {
    // Get users based on whether userId is provided
    let users;

    if (userId) {
      users = await User.findOne({ _id: userId, isVerified: true });
      console.log(`Running matching for specific user: ${userId}`);

      if (!users) {
        console.log(`No verified user found with id: ${userId}`);
        return;
      }

      users = [users]; // Wrap in an array for consistency
    } else {
      users = await User.find({ isVerified: true });
      console.log(`Found ${users.length} verified users to match with jobs`);
    }

    // Get jobs from the past month
    const oneMonthAgo = new Date();
    oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);

    const recentJobs = await JobListing.find({
      postedDate: { $gte: oneMonthAgo },
    });

    console.log(`Found ${recentJobs.length} recent jobs to match`);

    // Process each user
    for (const user of users) {
      console.log(`Processing matches for user: ${user.email}`);

      if (user.preferences?.matchingEnabled === false) {
        console.log(`Skipping user ${user.email} - matching disabled by user`);
        continue;
      }

      // Check wallet balance before processing
      const walletBalance = user.walletBalance || 0;
      if (walletBalance < 0.3) {
        console.log(
          `Skipping user ${
            user.email
          } - Insufficient wallet balance: $${walletBalance.toFixed(2)}`
        );
        continue;
      }

      // Check if user has already been charged today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const existingChargeToday = await Transaction.findOne({
        userId: user._id,
        type: "debit",
        amount: 0.3,
        status: "completed",
        createdAt: {
          $gte: today,
          $lt: tomorrow,
        },
      });

      const alreadyChargedToday = !!existingChargeToday;

      // Filter jobs and get existing matches
      const eligibleJobs = filterJobsForUser(recentJobs, user);
      const existingMatches = await MatchRecord.find({ userId: user._id });
      const matchedJobIds = new Set(
        existingMatches.map((match) => match.jobId.toString())
      );

      // Filter out jobs that have already been matched
      const jobsToProcess = eligibleJobs.filter(
        (job) => !matchedJobIds.has(job.id.toString())
      );

      if (jobsToProcess.length === 0) {
        console.log(`No new jobs to match for user ${user.email}`);
        continue;
      }

      console.log(
        `Processing ${jobsToProcess.length} new jobs for ${user.email} (${MATCHING_CONCURRENCY} concurrent)`
      );

      // Pre-fetch user QnA once (instead of fetching for every job)
      const userQnA: UserQnAData = await getUserQnA(user);

      // Create concurrency limiter
      const limit = pLimit(MATCHING_CONCURRENCY);

      // Process all jobs in parallel with concurrency limit
      const matchPromises = jobsToProcess.map((job) =>
        limit(async (): Promise<JobMatchResult | null> => {
          try {
            const result = await matchUserToJob(user, job, userQnA);
            return {
              job,
              matchScore: result.matchScore,
              verdict: result.verdict,
              reasoning: result.reasoning,
              freshness: result.freshness,
            };
          } catch (error) {
            console.error(
              `Error matching job ${job.title} for user ${user.email}:`,
              error
            );
            return null;
          }
        })
      );

      const results = await Promise.all(matchPromises);

      // Process results
      const matchRecords = [];
      const skippedRecords = [];
      const emailMatches: MatchSummaryItem[] = [];
      const minScore = user.preferences?.minScore || 30;

      for (const result of results) {
        if (!result) continue; // Skip failed matches

        if (result.matchScore < minScore) {
          // Below threshold - mark as auto-skipped
          skippedRecords.push({
            userId: user._id,
            jobId: result.job._id,
            matchScore: result.matchScore,
            verdict: "skipped",
            reasoning: result.reasoning || "Below minScore threshold",
            freshness: result.freshness,
            clicked: false,
            skipped: true,
          });

          console.log(
            `Auto-skipped job ${result.job.title} for ${user.email} - Score: ${result.matchScore}`
          );
        } else {
          // Good match
          matchRecords.push({
            userId: user._id,
            jobId: result.job._id,
            matchScore: result.matchScore,
            verdict: result.verdict,
            reasoning: result.reasoning,
            freshness: result.freshness,
            clicked: false,
          });

          emailMatches.push({
            title: result.job.title,
            company: result.job.company,
            url: result.job.url,
            matchScore: result.matchScore,
            freshness: result.freshness,
          });

          console.log(
            `Created match for ${user.email} with job ${result.job.title} - Score: ${result.matchScore}`
          );
        }
      }

      // Bulk insert all records
      if (skippedRecords.length > 0) {
        await MatchRecord.insertMany(skippedRecords);
        console.log(
          `Inserted ${skippedRecords.length} auto-skipped records for ${user.email}`
        );
      }

      if (matchRecords.length > 0) {
        await MatchRecord.insertMany(matchRecords);
        console.log(
          `Inserted ${matchRecords.length} match records for ${user.email}`
        );

        // Only charge if we haven't charged today yet
        if (!alreadyChargedToday) {
          // Deduct from wallet
          const updatedUser = await User.findById(user._id);
          if (updatedUser) {
            updatedUser.walletBalance = Math.max(
              0,
              (updatedUser.walletBalance || 0) - 0.3
            );
            await updatedUser.save();

            // Format date as "Dec 10, 2025" to match frontend display format
            const formattedDate = today.toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            });
            const description = `Job matching fee - ${formattedDate}`;

            await Transaction.create({
              userId: user._id,
              type: "debit",
              amount: 0.3,
              description,
              status: "completed",
              metadata: {
                matchesFound: matchRecords.length,
                deductionDate: today,
              },
            });

            console.log(
              `Deducted $0.30 from ${
                user.email
              }'s wallet. New balance: $${updatedUser.walletBalance.toFixed(2)}`
            );
          }
        } else {
          console.log(
            `Skipping charge for ${user.email} - already charged today`
          );
        }

        // Send match summary email (non-blocking for the matching flow)
        console.log(
          `[EMAIL] Preparing to send match summary email to ${user.email} with ${emailMatches.length} matches`
        );
        try {
          const emailSent = await sendMatchSummaryEmail(
            user,
            emailMatches,
            0.3
          );
          if (emailSent) {
            console.log(
              `[EMAIL] ✓ Email notification sent successfully to ${user.email}`
            );
          } else {
            console.log(
              `[EMAIL] ✗ Email notification was not sent to ${user.email} (check logs above for reason)`
            );
          }
        } catch (err) {
          console.error(
            `[EMAIL] ✗ Exception while sending email to ${user.email}:`,
            err
          );
        }
      }

      console.log(
        `Finished processing ${user.email}: ${matchRecords.length} matches, ${skippedRecords.length} auto-skipped`
      );
    }

    console.log("Daily job matching completed successfully");
  } catch (error) {
    console.error("Error during job matching:", error);
  } finally {
    console.timeEnd("Job matching");
  }
}

export default runDailyJobMatching;
