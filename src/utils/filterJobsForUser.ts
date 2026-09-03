import { Types } from "mongoose";

export const filterJobsForUser = <T extends { _id: { toString(): string } }>(
  jobs: T[],
  user: { skippedJobs: Types.ObjectId[] }
): T[] => {
  const skippedJobsIds = user.skippedJobs.map((id) => id.toString());
  return jobs.filter((job) => !skippedJobsIds.includes(job._id.toString()));
};
