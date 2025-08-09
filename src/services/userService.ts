import OpenAI from "openai";
import fs, { ReadStream } from "fs";
import { promisify } from "util";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

import User, { IUser } from "../models/User";
import { cvParserInstructions } from "../utils/cvParserInstructions";
import { getQuestionsInstructions } from "../utils/getQuestionsInstructions";
import { AnsweredQuestion } from "../types/AnsweredQuestion";
import { getAnswersInstructions } from "../utils/getAnswersInstructions";
import { questions } from "../utils/questions";
import { Readable } from "stream";
import { Question } from "../types/Question";
import { getAnswerComposerInstructions } from "../utils/getAnswerComposerInstructions";

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

const unlinkAsync = promisify(fs.unlink);
const MAX_TOKENS = 80000;

export const parseUserCV = async (uploadedFilePath: string) => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const ext = path.extname(uploadedFilePath).toLowerCase();
    let rawText = "";

    if (ext === ".pdf") {
      const fileData = fs.readFileSync(uploadedFilePath);
      const parsed = await pdfParse(fileData);
      rawText = parsed.text;
    } else if (ext === ".docx") {
      const result = await mammoth.extractRawText({ path: uploadedFilePath });
      rawText = result.value;
    } else {
      throw new Error(
        "Unsupported file type. Only PDF and DOCX are supported."
      );
    }

    const truncatedText =
      rawText.length > MAX_TOKENS
        ? rawText.slice(0, MAX_TOKENS) + "\n\n[TRUNCATED]"
        : rawText;

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: cvParserInstructions },
        {
          role: "user",
          content: `Here's my resume:\n\n${truncatedText}\n\nPlease parse it into the expected JSON structure.`,
        },
      ],
    });

    const rawOutput = response.choices?.[0]?.message?.content;

    if (!rawOutput) throw new Error("Empty response from OpenAI");

    const match = rawOutput.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in output");

    const parsed = JSON.parse(match[0]);

    await unlinkAsync(uploadedFilePath); // cleanup uploaded file

    return parsed;
  } catch (e) {
    console.error("Error parsing CV:", e);
    return null;
  }
};

export const getAIQuestion = async (user: IUser) => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
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
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const aiContent = getAnswersInstructions(
    answer,
    questions,
    answers,
    partialUserData
  );

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
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
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const response = await openai.audio.transcriptions.create({
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

export const getAnswerForQuestion = async (user: IUser, question: string) => {
  const answeredQuestions = await getUserQnA(user);
  const partialUserData = user.toObject();
  delete partialUserData._id;
  delete partialUserData.__v;
  delete partialUserData.password;
  delete partialUserData.createdAt;
  delete partialUserData.updatedAt;
  delete partialUserData.isVerified;
  delete partialUserData.qna;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: getAnswerComposerInstructions(
            answeredQuestions,
            partialUserData
          ),
        },
        {
          role: "user",
          content: `Here's a new question:\n\n${question}\n\nPlease generate an answer that matches the tone and style of the user's past answers.`,
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
