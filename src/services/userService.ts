import OpenAI from "openai";
import fs, { ReadStream } from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

import User, { IUser } from "../models/User";
import { cvParserInstructions } from "../utils/cvParserInstructions";
import { getQuestionsInstructions } from "../utils/getQuestionsInstructions";
import { AnsweredQuestion } from "../types/AnsweredQuestion";
import { getAnswersInstructions } from "../utils/getAnswersInstructions";
import { questions } from "../utils/questions";
import { Question } from "../types/Question";
import { getAnswerComposerInstructions } from "../utils/getAnswerComposerInstructions";
import { IJobListing } from "../models/JobListing";
import { IMatchRecord } from "../models/MatchRecord";
import { hasMeaningfulResume } from "../utils/resumePredicate";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

let _cvOpenai: OpenAI | null = null;
function getCvOpenAI(): OpenAI {
  if (!_cvOpenai) {
    _cvOpenai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20_000, maxRetries: 0 });
  }
  return _cvOpenai;
}

export const findUserByEmail = async (email: string) => {
  return User.findOne({ email });
};

export const getUserNameById = async (id: string) => {
  const user = await User.findOne({ _id: id });

  if (user) {
    return user.name || user.email;
  }

  return "-";
};

const MAX_TOKENS = 80000;

export const MIN_RESUME_TEXT_CHARS = 200;

export type CvParseErrorCode = "unreadable" | "invalid_output" | "transient" | "unsupported_type";

export class CvParseError extends Error {
  constructor(public code: CvParseErrorCode) {
    super(`CV parse failed: ${code}`);
    this.name = "CvParseError";
  }
}

const CV_RETRY_BACKOFF_MS = 500;

const sniffFileKind = (data: Buffer): "pdf" | "docx" | null => {
  if (data.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b) return "docx";
  return null;
};

const extractCvText = async (filePath: string): Promise<string> => {
  try {
    const fileData = fs.readFileSync(filePath);
    const kind = sniffFileKind(fileData);
    if (kind === null) throw new CvParseError("unsupported_type");
    if (kind === "pdf") {
      const parsed = await pdfParse(fileData);
      return parsed.text ?? "";
    }
    if (kind === "docx") {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value ?? "";
    }
    return "";
  } catch (e) {
    if (e instanceof CvParseError) throw e;
    console.error("Error extracting CV text:", e);
    throw new CvParseError("unreadable");
  }
};

type OpenAIErrorLike = { status?: unknown; name?: unknown; code?: unknown };

const isTransientOpenAIError = (e: unknown): boolean => {
  const err = (e ?? {}) as OpenAIErrorLike;
  if (typeof err.status === "number") {
    return err.status === 429 || err.status >= 500;
  }
  const name = typeof err.name === "string" ? err.name : "";
  const code = typeof err.code === "string" ? err.code : "";
  return (
    name.includes("APIConnection") ||
    /timeout/i.test(name) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)
  );
};

const callCvParserModel = async (text: string) => {
  const attempt = () =>
    getCvOpenAI().chat.completions.create({
      model: process.env.GPT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: cvParserInstructions },
        {
          role: "user",
          content: `Here's my resume:\n\n${text}\n\nPlease parse it into the expected JSON structure.`,
        },
      ],
    });

  try {
    return await attempt();
  } catch (first) {
    if (!isTransientOpenAIError(first)) throw first;
    console.error("Transient OpenAI error parsing CV, retrying once:", first);
    await new Promise((resolve) => setTimeout(resolve, CV_RETRY_BACKOFF_MS));
    try {
      return await attempt();
    } catch (second) {
      if (!isTransientOpenAIError(second)) throw second;
      console.error("OpenAI error persisted after retry:", second);
      throw new CvParseError("transient");
    }
  }
};

export const parseUserCV = async (uploadedFilePath: string) => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const rawText = await extractCvText(uploadedFilePath);
  if (rawText.trim().length < MIN_RESUME_TEXT_CHARS) {
    throw new CvParseError("unreadable");
  }

  const truncatedText =
    rawText.length > MAX_TOKENS
      ? rawText.slice(0, MAX_TOKENS) + "\n\n[TRUNCATED]"
      : rawText;

  const response = await callCvParserModel(truncatedText);

  const rawOutput = response.choices?.[0]?.message?.content;
  if (!rawOutput) throw new CvParseError("invalid_output");

  const match = rawOutput.match(/\{[\s\S]*\}/);
  if (!match) throw new CvParseError("invalid_output");

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new CvParseError("invalid_output");
  }

  if (!parsed || typeof parsed !== "object" || !hasMeaningfulResume(parsed.resume)) {
    throw new CvParseError("invalid_output");
  }

  return parsed;
};

export const getAIQuestion = async (user: IUser) => {
  const answers = user.qna || [];
  const partialUserData = user.toObject();
  delete partialUserData._id;
  delete partialUserData.__v;
  delete partialUserData.password;
  delete partialUserData.createdAt;
  delete partialUserData.updatedAt;
  delete partialUserData.isVerified;
  delete partialUserData.qna;

  try {
    const pendingQuestions = questions.filter((question: Question) => {
      const existingIndex = answers.findIndex(
        (answer) =>
          answer.questionId === question.id ||
          (answer.questionId === question.id && answer.skipped)
      );

      return existingIndex < 0;
    });

    const response = await getOpenAI().chat.completions.create({
      model: process.env.GPT_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: getQuestionsInstructions(
            partialUserData,
            answers,
            pendingQuestions
          ),
        },
      ],
    });

    const question = response.choices?.[0]?.message?.content;

    if (!question) throw new Error("Empty response from OpenAI");

    return question;
  } catch (e) {
    console.error("Error generating AI question:", e);
    return null;
  }
};

export const answerQuestion = async (user: IUser, answer: AnsweredQuestion) => {
  const answers = user.qna || [];
  const partialUserData = user.toObject();
  delete partialUserData._id;
  delete partialUserData.__v;
  delete partialUserData.password;
  delete partialUserData.createdAt;
  delete partialUserData.updatedAt;
  delete partialUserData.isVerified;
  delete partialUserData.qna;
  const aiContent = getAnswersInstructions(
    answer,
    questions,
    answers,
    partialUserData
  );

  try {
    const response = await getOpenAI().chat.completions.create({
      model: process.env.GPT_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: aiContent,
        },
      ],
    });

    const result = response.choices?.[0]?.message?.content;

    if (!result) throw new Error("Empty response from OpenAI");

    const parsedResponses = JSON.parse(result);

    if (parsedResponses.length === 0) {
      console.error("No responses found in parsed output");
      return false;
    }

    const finalAnswers = [...answers];

    parsedResponses.forEach((item: any) => {
      const existingIndex = finalAnswers.findIndex(
        (answer) => answer.questionId === item.questionId
      );

      if (existingIndex >= 0) {
        finalAnswers[existingIndex] = {
          questionId: item.questionId,
          answer: item.rephrasedAnswer,
          mode: answer.mode,
        };
      } else {
        finalAnswers.push({
          questionId: item.questionId,
          answer: item.rephrasedAnswer,
          mode: answer.mode,
        });
      }
    });

    await User.findByIdAndUpdate(user._id, { qna: finalAnswers });

    return true;
  } catch (e) {
    console.error("Error answering question:", e);
    return null;
  }
};

export const parseAudioAnswer = async (audioBuffer: ReadStream) => {

  try {
    const response = await getOpenAI().audio.transcriptions.create({
      file: audioBuffer,
      model: "whisper-1",
      response_format: "text",
    });

    if (!response) {
      console.error("Empty response from OpenAI");
      return null;
    }

    return response;
  } catch (e) {
    console.error("Error parsing audio answer:", e);
    return null;
  }
};

export const getUserQnA = async (user: IUser) => {
  const answers = user.qna || [];
  const answeredQuestions: (Question & Omit<AnsweredQuestion, "questionId">)[] =
    answers.map((item) => {
      const question = questions.find(
        (q) => q.id === item.questionId
      ) as Question;

      return {
        ...question,
        answer: item.answer,
        mode: item.mode,
      };
    });

  return answeredQuestions;
};

export const skipQuestion = async (user: IUser, questionId: string) => {
  const answers = user.qna || [];

  const existingIndex = answers.findIndex(
    (answer) => answer.questionId === questionId
  );

  if (existingIndex >= 0) {
    // we don't do anything if the question is already answered
    return true;
  }

  const skippedQuestion = {
    questionId,
    answer: "",
    mode: "text",
    skipped: true,
  };

  const finalAnswers = [...answers, skippedQuestion];
  await User.findByIdAndUpdate(user._id, { qna: finalAnswers });

  return true;
};

export const getAnswerForQuestion = async (
  user: IUser,
  question: string,
  jobResult?: IJobListing | null,
  matchRecord?: IMatchRecord | null,
  customInstructions?: string
) => {
  const answeredQuestions = await getUserQnA(user);
  const partialUserData = user.toObject();
  delete partialUserData._id;
  delete partialUserData.__v;
  delete partialUserData.password;
  delete partialUserData.createdAt;
  delete partialUserData.updatedAt;
  delete partialUserData.isVerified;
  delete partialUserData.qna;

  let jobDetails = null;

  if (jobResult) {
    jobDetails = jobResult.toObject();
    delete jobDetails._id;
    delete jobDetails.__v;
    delete jobDetails.createdAt;
    delete jobDetails.updatedAt;
  }

  // Build matchQnAHistory from the trusted matchRecord object passed in
  let matchQnAHistory: Array<{ question: string; answer: string }> = [];
  if (matchRecord && matchRecord.qna && matchRecord.qna.length > 0) {
    const sortedQnA = [...matchRecord.qna]
      .sort((a, b) => {
        const dateA = a.createdAt || new Date(0);
        const dateB = b.createdAt || new Date(0);
        return dateB.getTime() - dateA.getTime();
      })
      .slice(0, 10);

    matchQnAHistory = sortedQnA.map((qa) => ({
      question: qa.question,
      answer: qa.answer,
    }));
  }


  try {
    const response = await getOpenAI().chat.completions.create({
      model: process.env.GPT_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: getAnswerComposerInstructions(
            answeredQuestions,
            partialUserData,
            jobResult,
            matchQnAHistory,
            customInstructions
          ),
        },
        {
          role: "user",
          content: `Here's a new question:\n\n${question}\n\nPlease generate an answer that matches the tone and style of the user's past answers.${
            matchQnAHistory.length > 0
              ? "\n\nIMPORTANT: This question may be related to previous questions asked for this same job application. Review the previous Q&A history below to ensure consistency and avoid repetition. If the question is similar to a previous one, you can reference or build upon the previous answer while still directly addressing the new question."
              : ""
          }`,
        },
      ],
    });

    const result = response.choices?.[0]?.message?.content;

    if (!result) throw new Error("Empty response from OpenAI");

    return result;
  } catch (e) {
    console.error("Error generating answer for question:", e);
    return null;
  }
};
