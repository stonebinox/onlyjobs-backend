import { IJobListing } from "../models/JobListing";
import { IUser } from "../models/User";

export const filterJobsForUser = (
  jobs: IJobListing[],
  user: IUser
): IJobListing[] => {
  const skippedJobsIds = user.skippedJobs.map((id) => id.toString());
  return jobs.filter((job) => !skippedJobsIds.includes(job.id.toString()));
};
