import User from "../models/User";
import JobListing from "../models/JobListing";
import MatchRecord from "../models/MatchRecord";
import { matchUserToJob } from "../services/matchingService";
import { filterJobsForUser } from "../utils/filterJobsForUser";

export async function runDailyJobMatching(userId?: string): Promise<void> {
  console.log("Starting daily job matching task...");
  console.time("Job matching");

  try {
    // Get users based on whether userId is provided
    let users;

    if (userId) {
      users = await User.findOne({ _id: userId });
      console.log(`Running matching for specific user: ${userId}`);

      if (!users) {
        console.log(`No user found with email: ${userId}`);
        return;
      }

      users = [users]; // Wrap in an array for consistency
    } else {
      users = await User.find(); // todo: we should match only based on whether they're verified
      console.log(`Found ${users.length} users to match with jobs`);
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

      const eligibleJobs = filterJobsForUser(recentJobs, user);
      const existingMatches = await MatchRecord.find({ userId: user._id });
      const matchedJobIds = new Set(
        existingMatches.map((match) => match.jobId.toString())
      );

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
  } finally {
    console.timeEnd("Job matching");
  }
}

export default runDailyJobMatching;
