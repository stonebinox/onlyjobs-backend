import User from "../models/User";
import JobListing from "../models/JobListing";
import MatchRecord from "../models/MatchRecord";
import { matchUserToJob, filterJobsForUser } from "../services/matchingService";

export async function runDailyJobMatching(): Promise<void> {
  console.log("Starting daily job matching task...");

  try {
    // Get all users
    const users = await User.find();
    console.log(`Found ${users.length} users to match with jobs`);

    // Get jobs from the past week only
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const recentJobs = await JobListing.find({
      scrapedDate: { $gte: oneWeekAgo },
    });

    console.log(`Found ${recentJobs.length} recent jobs to match`);

    // Process each user
    for (const user of users) {
      console.log(`Processing matches for user: ${user.email}`);

      // Filter out jobs the user has already skipped
      const eligibleJobs = filterJobsForUser(recentJobs, user);

      // Get existing matches to avoid duplicates
      const existingMatches = await MatchRecord.find({ userId: user._id });
      const matchedJobIds = new Set(
        existingMatches.map((match) => match.jobId.toString())
      );

      // Process each job for this user
      for (const job of eligibleJobs) {
        // Skip if we already have a match record
        if (matchedJobIds.has(job.id.toString())) {
          continue;
        }

        // Perform the matching using AI
        const matchResult = await matchUserToJob(user, job);

        // Save the match result
        await MatchRecord.create({
          userId: user._id,
          jobId: job._id,
          matchScore: matchResult.matchScore,
          verdict: matchResult.verdict,
          reasoning: matchResult.reasoning,
          freshness: matchResult.freshness,
          clicked: false,
        });

        console.log(
          `Created match for ${user.email} with job ${job.title} - Score: ${matchResult.matchScore}`
        );
      }
    }

    console.log("Daily job matching completed successfully");
  } catch (error) {
    console.error("Error during job matching:", error);
  }
}

// This function will be called by a scheduler
export default runDailyJobMatching;
