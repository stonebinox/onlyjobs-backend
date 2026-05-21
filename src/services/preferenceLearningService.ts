import OpenAI from "openai";

import User, { IUser } from "../models/User";
import { IJobListing } from "../models/JobListing";
import { IMatchRecord, RejectionReason } from "../models/MatchRecord";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Reason categories that should NOT be used for learning
const NON_LEARNING_CATEGORIES = ["job_inactive"];

interface AnalysisResult {
  insights: string;
  feedbackCount: number;
}

const buildPreferenceLearningPrompt = (): string => {
  return `You are an AI assistant that helps improve job matching by learning from user feedback.

When a user rejects a matched job, they provide a reason category and optional details text. Your job is to update their preference insights based on what the rejection actually reveals.

CRITICAL RULE: The reason category is the PRIMARY signal. It tells you WHY the user rejected the job. Only learn about the aspect of the job that matches the reason — do NOT draw conclusions about unrelated attributes.

Reason category → what to learn:
- "location": Learn about location/region constraints (e.g., can't work US-only remote roles). Do NOT learn anything about the job's role type, title, or tech stack.
- "salary": Learn about compensation expectations. Do NOT learn anything about the job's role type.
- "company_type": Learn about company size/stage preferences. Do NOT learn anything about the job's role type.
- "role_mismatch": Learn about role/job-type preferences (e.g., prefers SRE over generic DevOps). This is the only category where you should update role-related insights.
- "skills_gap": Learn about what the user considers outside their current skill set.
- "other": Read the user's details text carefully to determine what the actual preference is.

NEVER generalize from the job's title, tech stack, or description when the reason is "location", "salary", or "company_type". Those are properties of this specific listing, not signals about role preferences.

When updating existing insights:
- Preserve insights that are still valid and unrelated to the current rejection's category.
- Only modify or add insights related to the current rejection's reason category.

The updated insights string must be:
- Concise (max 200 words)
- Written as factual statements about user preferences
- Actionable for future job matching

Example insights format:
"Cannot work US-only remote roles (based in Uruguay). Minimum salary expectation around $150k. Avoids early-stage startups under 50 employees. Prefers SRE roles over generic DevOps titles."

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
