import { IUser } from "../models/User";
import { IJobListing } from "../models/JobListing";
import { Freshness } from "../models/MatchRecord";

interface MatchResult {
  matchScore: number;
  verdict: string;
  reasoning: string;
  freshness: Freshness;
}

export const calculateJobFreshness = (job: IJobListing): Freshness => {
  const now = new Date();
  const scrapedDate = new Date(job.scrapedDate);
  const daysDiff = Math.floor(
    (now.getTime() - scrapedDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysDiff < 2) {
    return Freshness.FRESH;
  } else if (daysDiff < 7) {
    return Freshness.WARM;
  } else {
    return Freshness.STALE;
  }
};

export const matchUserToJob = async (
  user: IUser,
  job: IJobListing
): Promise<MatchResult> => {
  // TODO: Implement the AI matching logic using OpenAI or Claude
  // This will analyze user resume and preferences against job listing

  // For now, return a placeholder result
  return {
    matchScore: Math.floor(Math.random() * 100), // Random score for placeholder
    verdict: "Placeholder verdict",
    reasoning:
      "This is a placeholder for the AI reasoning that will explain why this job matches the user profile.",
    freshness: calculateJobFreshness(job),
  };
};

export const filterJobsForUser = (
  jobs: IJobListing[],
  user: IUser
): IJobListing[] => {
  // Filter out jobs that the user has already skipped
  const skippedJobsIds = user.skippedJobs.map((id) => id.toString());
  return jobs.filter((job) => !skippedJobsIds.includes(job.id.toString()));
};
