import OpenAI from "openai";

import { IUser } from "../models/User";
import JobListing, { IJobListing } from "../models/JobListing";
import MatchRecord, { Freshness } from "../models/MatchRecord";
import { jobMatcherPrompt } from "../utils/jobMatcherPrompt";
import { getUserQnA } from "./userService";

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
  const answeredQuestions = await getUserQnA(user);

  const userInfo = {
    name: user.name,
    resume: user.resume,
    preferences: user.preferences,
    questionsAndAnswers: answeredQuestions.map((item) => ({
      question: item.question,
      answer: item.answer,
    })),
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

export const getMatchesData = async (
  userId: string,
  minMatchScore: number = 0
) => {
  const matches = await MatchRecord.find({
    userId,
    matchScore: { $gte: minMatchScore },
  });

  const matchPromises = matches.map(async (match) => {
    const job = await JobListing.findById(match.jobId);
    const populatedMatch = {
      ...match.toObject(),
      job,
    };

    return populatedMatch;
  });

  const populatedMatches = await Promise.all(matchPromises);
  const sortedMatches = populatedMatches.sort(
    (a, b) => b.matchScore - a.matchScore
  );

  return sortedMatches;
};

export const markMatchAsClicked = async (matchId: string) => {
  const match = await MatchRecord.findById(matchId);

  if (!match) throw new Error("Match not found");

  match.clicked = true;
  match.skipped = false; // Reset skipped status
  await match.save();

  return true;
};

export const skipMatch = async (matchId: string) => {
  const match = await MatchRecord.findById(matchId);

  if (!match) throw new Error("Match not found");

  match.skipped = true;
  await match.save();

  return true;
};
