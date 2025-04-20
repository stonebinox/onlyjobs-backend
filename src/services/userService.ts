import OpenAI from "openai";
import fs from "fs";
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
      model: "gpt-4o-mini",
      temperature: 0,
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
  const partialUserData = user.toObject();
  delete partialUserData._id;
  delete partialUserData.__v;
  delete partialUserData.password;
  delete partialUserData.createdAt;
  delete partialUserData.updatedAt;
  delete partialUserData.isVerified;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: getQuestionsInstructions(partialUserData) },
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
      model: "gpt-4o-mini",
      temperature: 0,
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
      finalAnswers.push({
        questionId: item.questionId,
        answer: item.rephrasedAnswer,
        mode: answer.mode,
      });
    });

    await User.findByIdAndUpdate(user._id, { qna: finalAnswers });

    return true;
  } catch (e) {
    console.error("Error answering question:", e);
    return null;
  }
};
