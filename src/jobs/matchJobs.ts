import User from "../models/User";
import JobListing from "../models/JobListing";
import MatchRecord from "../models/MatchRecord";
import Transaction from "../models/Transaction";
import { matchUserToJob } from "../services/matchingService";
import {
  MatchSummaryItem,
  sendMatchSummaryEmail,
} from "../services/emailService";
import { filterJobsForUser } from "../utils/filterJobsForUser";

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

      // Check wallet balance before processing
      const walletBalance = user.walletBalance || 0;
      if (walletBalance < 0.3) {
        console.log(
          `Skipping user ${user.email} - Insufficient wallet balance: $${walletBalance.toFixed(2)}`
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

      const eligibleJobs = filterJobsForUser(recentJobs, user);
      const existingMatches = await MatchRecord.find({ userId: user._id });
      const matchedJobIds = new Set(
        existingMatches.map((match) => match.jobId.toString())
      );

      let matchFound = false;
      const matchRecords = [];
      const emailMatches: MatchSummaryItem[] = [];

      for (const job of eligibleJobs) {
        if (matchedJobIds.has(job.id.toString())) {
          continue;
        }

        const matchResult = await matchUserToJob(user, job);

        if (matchResult.matchScore < (user.preferences?.minScore || 30)) {
          console.log(
            `Skipping job ${job.title} for user ${user.email} - Score: ${matchResult.matchScore}`
          );

          await MatchRecord.create({
            userId: user._id,
            jobId: job._id,
            matchScore: matchResult.matchScore,
            verdict: "skipped",
            reasoning: matchResult.reasoning || "Below minScore threshold",
            freshness: matchResult.freshness,
            clicked: false,
            skipped: true,
          });

          continue;
        }

        matchFound = true;
        matchRecords.push({
          userId: user._id,
          jobId: job._id,
          matchScore: matchResult.matchScore,
          verdict: matchResult.verdict,
          reasoning: matchResult.reasoning,
          freshness: matchResult.freshness,
          clicked: false,
        });

        emailMatches.push({
          title: job.title,
          company: job.company,
          url: job.url,
          matchScore: matchResult.matchScore,
          freshness: matchResult.freshness,
        });

        console.log(
          `Created match for ${user.email} with job ${job.title} - Score: ${matchResult.matchScore}`
        );
      }

      // If at least one match was found, create match records
      if (matchFound) {
        // Create all match records
        await MatchRecord.insertMany(matchRecords);

        // Only charge if we haven't charged today yet
        if (!alreadyChargedToday) {
          // Deduct from wallet
          const updatedUser = await User.findById(user._id);
          if (updatedUser) {
            updatedUser.walletBalance = Math.max(0, (updatedUser.walletBalance || 0) - 0.3);
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
              `Deducted $0.30 from ${user.email}'s wallet. New balance: $${updatedUser.walletBalance.toFixed(2)}`
            );
          }
        } else {
          console.log(
            `Skipping charge for ${user.email} - already charged today`
          );
        }

        // Send match summary email (non-blocking for the matching flow)
        console.log(`[EMAIL] Preparing to send match summary email to ${user.email} with ${emailMatches.length} matches`);
        try {
          const emailSent = await sendMatchSummaryEmail(user, emailMatches, 0.3);
          if (emailSent) {
            console.log(`[EMAIL] ✓ Email notification sent successfully to ${user.email}`);
          } else {
            console.log(`[EMAIL] ✗ Email notification was not sent to ${user.email} (check logs above for reason)`);
          }
        } catch (err) {
          console.error(`[EMAIL] ✗ Exception while sending email to ${user.email}:`, err);
        }
      }
    }

    console.log("Daily job matching completed successfully");
  } catch (error) {
    console.error("Error during job matching:", error);
  } finally {
    console.timeEnd("Job matching");
  }
}

export default runDailyJobMatching;
