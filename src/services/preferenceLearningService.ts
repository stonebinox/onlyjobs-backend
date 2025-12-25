import OpenAI from "openai";

import User, { IUser } from "../models/User";
import { IJobListing } from "../models/JobListing";
import { IMatchRecord, RejectionReason } from "../models/MatchRecord";

// Reason categories that should NOT be used for learning
const NON_LEARNING_CATEGORIES = ["job_inactive"];

interface AnalysisResult {
  insights: string;
  feedbackCount: number;
}

const buildPreferenceLearningPrompt = (): string => {
  return `You are an AI assistant that helps improve job matching by learning from user feedback.

When a user says "No" to a matched job (meaning they chose not to apply after reviewing it), you need to analyze their reason and update their preference insights.

Your task:
1. Analyze the user's reason for not applying
2. Consider the context: their profile, the job details, and their existing learned preferences
3. Generate an updated "insights" string that captures what we've learned about this user's preferences

The insights string should be:
- Concise but comprehensive (max 200 words)
- Written as factual statements about user preferences
- Focused on actionable patterns that can improve future matching
- Updated to incorporate the new feedback while preserving relevant existing insights

Example insights format:
"Prefers fully remote roles. Avoids early-stage startups (under 50 employees). Minimum salary expectation around $150k. Not interested in roles requiring travel >10%. Prefers product-focused companies over agencies."

Respond with a JSON object:
{
  "updatedInsights": "string with the updated preference insights"
}`;
};

export const analyzeRejectionAndUpdatePreferences = async (
  user: IUser,
  job: IJobListing,
  matchRecord: IMatchRecord,
  reason: RejectionReason
): Promise<AnalysisResult | null> => {
  // Skip learning for non-learning categories
  if (NON_LEARNING_CATEGORIES.includes(reason.category)) {
    console.log(
      `Skipping preference learning for category: ${reason.category}`
    );
    return null;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const existingInsights = user.learnedPreferences?.insights || "None yet.";
  const existingFeedbackCount = user.learnedPreferences?.feedbackCount || 0;

  const userContext = {
    name: user.name,
    resume: {
      skills: user.resume?.skills || [],
      experience: user.resume?.experience || [],
      summary: user.resume?.summary || "",
    },
    preferences: user.preferences,
    existingLearnedPreferences: existingInsights,
    feedbackCount: existingFeedbackCount,
  };

  const jobContext = {
    title: job.title,
    company: job.company,
    location: job.location,
    salary: job.salary,
    tags: job.tags,
    description: job.description?.substring(0, 1000) || "", // Truncate long descriptions
  };

  const matchContext = {
    matchScore: matchRecord.matchScore,
    verdict: matchRecord.verdict,
    reasoning: matchRecord.reasoning,
  };

  const rejectionContext = {
    category: reason.category,
    details: reason.details || "No additional details provided",
  };

  try {
    const response = await openai.chat.completions.create({
      model: process.env.GPT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: buildPreferenceLearningPrompt() },
        {
          role: "user",
          content: `User Profile:
${JSON.stringify(userContext, null, 2)}

Job That Was Rejected:
${JSON.stringify(jobContext, null, 2)}

Original Match Assessment:
${JSON.stringify(matchContext, null, 2)}

User's Reason for Not Applying:
${JSON.stringify(rejectionContext, null, 2)}

Analyze this rejection and provide updated preference insights.`,
        },
      ],
    });

    const output = response.choices[0]?.message?.content;
    if (!output) {
      console.error("No response from OpenAI for preference learning");
      return null;
    }

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("No JSON found in OpenAI preference learning output");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const newFeedbackCount = existingFeedbackCount + 1;

    // Update user's learned preferences
    await User.findByIdAndUpdate(user._id, {
      learnedPreferences: {
        insights: parsed.updatedInsights,
        lastUpdated: new Date(),
        feedbackCount: newFeedbackCount,
      },
    });

    console.log(
      `Updated learned preferences for user ${user.email}. Feedback count: ${newFeedbackCount}`
    );

    return {
      insights: parsed.updatedInsights,
      feedbackCount: newFeedbackCount,
    };
  } catch (error) {
    console.error("Error in preference learning analysis:", error);
    return null;
  }
};

// Reason category labels for frontend display
export const REASON_CATEGORIES = {
  salary: "Salary/compensation too low",
  location: "Location/remote policy doesn't match",
  skills_gap: "Missing required skills/experience",
  company_type: "Company size/stage not preferred",
  role_mismatch: "Responsibilities don't match my goals",
  job_inactive: "Job no longer available",
  other: "Other",
} as const;

export type ReasonCategory = keyof typeof REASON_CATEGORIES;
