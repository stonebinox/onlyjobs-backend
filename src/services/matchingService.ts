import OpenAI from "openai";

import { IUser } from "../models/User";
import { IJobListing } from "../models/JobListing";
import { Freshness } from "../models/MatchRecord";
import { jobMatcherPrompt } from "../utils/jobMatcherPrompt";

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

  if (daysDiff < 7) return Freshness.FRESH;
  if (daysDiff < 15) return Freshness.WARM;

  return Freshness.STALE;
};

export const matchUserToJob = async (
  user: IUser,
  job: IJobListing
): Promise<MatchResult> => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userInfo = {
    name: user.name,
    resume: user.resume,
    preferences: user.preferences,
  };

  const jobInfo = {
    title: job.title,
    company: job.company,
    location: job.location,
    salary: job.salary,
    tags: job.tags,
    source: job.source,
    description: job.description,
  };

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: jobMatcherPrompt },
      {
        role: "user",
        content: `User:
${JSON.stringify(userInfo, null, 2)}

Job:
${JSON.stringify(jobInfo, null, 2)}

Evaluate this match.`,
      },
    ],
  });

  const output = response.choices[0]?.message?.content;
  if (!output) throw new Error("No response from OpenAI");

  const match = output.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in OpenAI output");

  const parsed = JSON.parse(match[0]);

  return {
    matchScore: parsed.matchScore,
    verdict: parsed.verdict,
    reasoning: parsed.reasoning,
    freshness: calculateJobFreshness(job),
  };
};
