import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import bcrypt from "bcrypt";
import path from "path";
import fs from "fs";
import { tmpdir } from "os";
import { v4 as uuidv4 } from "uuid";

import User from "../models/User";
import {
  answerQuestion,
  findUserByEmail,
  getAIQuestion,
  getAnswerForQuestion,
  getUserNameById,
  getUserQnA,
  parseAudioAnswer,
  parseUserCV,
  skipQuestion,
} from "../services/userService";
import { generateToken } from "../utils/generateToken";
import { AnsweredQuestion } from "../types/AnsweredQuestion";
import { deleteAllMatches } from "../services/matchingService";
import MatchRecord from "../models/MatchRecord";
import JobListing, { IJobListing } from "../models/JobListing";

const saltRounds = 10;

export const authenticateUser = asyncHandler(
  async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (
      !email ||
      !password ||
      email.trim() === "" ||
      password.trim() === "" ||
      password.length < 8
    ) {
      res.status(400);
      throw new Error("Please provide valid email and password");
    }

    // we find user by email to see if one exists
    let user = await findUserByEmail(email);
    const encryptedPassword = await bcrypt.hash(password, saltRounds);

    if (!user) {
      // we create the user
      user = await User.create({
        email,
        password: encryptedPassword,
      });
      // TODO: send verification email when we integrate email service
    } else {
      // we check if the password is correct
      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        res.status(401);
        throw new Error("Invalid email or password");
      }
    }

    // we generate a token
    const token = generateToken(user.id);

    res.status(200).json({
      id: user.id,
      token: token,
    });
  }
);

// @desc    Get user's name
// @route   GET /api/users/username
// @access  Private
export const getUserName = asyncHandler(async (req: Request, res: Response) => {
  const username = await getUserNameById(req.user?.id);

  res.status(200).json({
    username,
  });
});

// @desc    Get active user count
// @route   GET /api/users/active-count
// @access  Private
export const getActiveUserCount = asyncHandler(
  async (req: Request, res: Response) => {
    const activeUserCount = await User.countDocuments({ isVerified: true });

    res.status(200).json({
      activeUserCount,
    });
  }
);

// @desc    Update user's CV - will be parsed by AI
// @route   POST /api/users/cv
// @access  Private
export const updateUserCV = asyncHandler(
  async (req: Request, res: Response) => {
    // Check if file exists in the request
    if (!req.file) {
      res.status(400);
      throw new Error("Please upload a file");
    }

    const userId = req.user?.id;
    const file = req.file;

    // Check file type
    const allowedFileTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    if (!allowedFileTypes.includes(file.mimetype)) {
      res.status(400);
      throw new Error("Please upload a PDF or Word document");
    }

    try {
      const uploadDir = path.join(__dirname, "../../uploads/cvs");

      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const fileExtension = path.extname(file.originalname);
      const fileName = `${userId}-${Date.now()}${fileExtension}`;
      const filePath = path.join(uploadDir, fileName);
      fs.writeFileSync(filePath, file.buffer);
      const parsedCV = await parseUserCV(filePath);

      const updatePayload: any = {
        resume: parsedCV.resume,
      };

      if (parsedCV.name) {
        updatePayload.name = parsedCV.name;
      }

      if (parsedCV.location) {
        updatePayload["preferences.location"] = [parsedCV.location];
        updatePayload["preferences.remoteOnly"] =
          parsedCV.location.toLowerCase() === "remote";
      }

      if (parsedCV.preferences) {
        updatePayload.preferences = {
          ...updatePayload.preferences,
          ...parsedCV.preferences,
        };
      }

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        {
          name: parsedCV.name,
          resume: parsedCV.resume,
          preferences: parsedCV.preferences,
        },
        { new: true }
      );

      if (!updatedUser) {
        res.status(404);
        throw new Error("User not found");
      }

      res.status(200).json({
        success: true,
        message: "CV uploaded successfully",
      });
    } catch (error) {
      console.error("Error saving CV:", error);
      res.status(500);
      throw new Error("Error saving CV");
    }
  }
);

// @desc    Get AI-generated question for user
// @route   GET /api/users/question
// @access  Private
export const getQuestion = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.id;

  const user = await User.findById(userId);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const question = await getAIQuestion(user);

  res.status(200).json({
    question,
  });
});

// @desc    Set user's answer to a question
// @route   POST /api/users/answer
// @access  Private
export const setUserAnswer = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const { answer } = req.body;

    if (
      !answer ||
      answer.answer.trim() === "" ||
      !answer.questionId ||
      answer.questionId.trim() === "" ||
      !answer.mode ||
      (answer.mode !== "text" && answer.mode !== "voice")
    ) {
      res.status(400);
      throw new Error("Please provide a valid answer");
    }

    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    const response = await answerQuestion(user, answer);

    if (!response) {
      res.status(200).json({
        success: false,
        message: "Invalid answer",
      });

      return;
    }

    res.status(200).json({
      success: true,
      message: "Answer saved successfully",
    });
  }
);

// @desc    Set user's audio answer to a question
// @route   POST /api/users/answer-audio
// @access  Private
export const setAudioAnswer = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400);
      throw new Error("No audio captured");
    }

    const { questionId } = req.body;
    if (!questionId || questionId.trim() === "") {
      res.status(400);
      throw new Error("Please provide a valid question ID");
    }

    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    const file = req.file;
    const tempFilename = path.join(tmpdir(), `${uuidv4()}.webm`);
    fs.writeFileSync(tempFilename, file.buffer);
    const stream = fs.createReadStream(tempFilename);

    try {
      const transcript = await parseAudioAnswer(stream);
      fs.unlinkSync(tempFilename);

      if (!transcript) {
        res.status(500);
        throw new Error("Error parsing audio answer");
      }

      const parsedAnswer: AnsweredQuestion = {
        questionId,
        answer: transcript,
        mode: "voice",
      };
      const response = await answerQuestion(user, parsedAnswer);

      if (!response) {
        res.status(200).json({
          success: false,
          message: "Invalid answer",
        });

        return;
      }

      res.status(200).json({
        success: true,
        message: "Answer saved successfully",
      });
    } catch (error) {
      console.error("Error parsing audio answer:", error);
      res.status(500);
      throw new Error("Error parsing audio answer");
    }
  }
);

// @desc    Get answered questions
// @route   GET /api/users/answered-questions
// @access  Private
export const getAnsweredQuestions = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const user = await User.findById(userId);
    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    const answeredQuestions = await getUserQnA(user);

    res.status(200).json({
      answeredQuestions,
    });
  }
);

export const setSkippedQuestion = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const { questionId } = req.body;

    if (!questionId || questionId.trim() === "") {
      res.status(400);
      throw new Error("Please provide a valid question ID");
    }

    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    try {
      await skipQuestion(user, questionId);
      res.status(200).json({
        success: true,
        message: "Question skipped successfully",
      });
    } catch (e) {
      console.error("Error skipping question:", e);
      res.status(500);
      throw new Error("Error skipping question");
    }
  }
);

export const createAnswer = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const { question } = req.body;

    if (!question || question.trim() === "") {
      res.status(400);
      throw new Error("Please provide a valid question");
    }
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    let jobDetails = null;

    if (req.body.jobResultId) {
      const jobResultId = req.body.jobResultId;
      let jobResult = await MatchRecord.findById(jobResultId);

      if (!jobResult) {
        jobResult = null;
      } else {
        const jobId = jobResult.jobId;
        jobDetails = (await JobListing.findById(
          jobId.toString()
        )) as IJobListing | null;
      }
    }

    try {
      const answer = await getAnswerForQuestion(user, question, jobDetails);

      if (!answer) {
        res.status(200).json({
          success: false,
          message: "Invalid answer",
        });

        return;
      }

      res.status(200).json({
        success: true,
        answer,
      });
    } catch (e) {
      console.error("Error creating answer:", e);
      res.status(500);
      throw new Error("Error creating answer");
    }
  }
);

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
export const updateUserProfile = asyncHandler(
  async (req: Request, res: Response) => {
    // TODO: Implement update profile logic
    res.json({
      message: "User profile updated",
    });
  }
);

// @desc    Skip a job (don't show it again)
// @route   POST /api/users/skip/:jobId
// @access  Private
export const skipJob = asyncHandler(async (req: Request, res: Response) => {
  // TODO: Implement job skipping logic
  res.json({
    message: "Job skipped successfully",
  });
});

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
export const getUserProfile = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        preferences: user.preferences,
        resume: user.resume,
        createdAt: user.createdAt,
      },
    });
  }
);

// @desc    Update user email address
// @route   PUT /api/users/email
// @access  Private
export const updateUserEmailAddress = asyncHandler(
  async (req: Request, res: Response) => {
    const { email } = req.body;

    if (!email || email.trim() === "") {
      res.status(400);
      throw new Error("Please provide a valid email");
    }

    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    // todo: we should attempt to send a verification email here
    user.email = email;
    await user.save();

    res.status(200).json({
      message: "Email updated successfully",
    });
  }
);

// @desc    update password
// @route   PUT /api/users/password
// @access  Private
export const updatePassword = asyncHandler(
  async (req: Request, res: Response) => {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      res.status(400);
      throw new Error("Please provide both old and new passwords");
    }

    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);

    if (!isMatch) {
      res.status(401);
      throw new Error("Old password is incorrect");
    }

    user.password = await bcrypt.hash(newPassword, saltRounds);
    await user.save();

    res.status(200).json({
      message: "Password updated successfully",
    });
  }
);

// @desc    Update minimum match score
// @route   PUT /api/users/update-mini-score
// @access  Private
export const updateMinMatchScore = asyncHandler(
  async (req: Request, res: Response) => {
    const { minScore } = req.body;

    if (minScore < 0 || minScore > 100) {
      res.status(400);
      throw new Error("Please provide a valid score between 0 and 100");
    }

    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    user.preferences.minScore = minScore;
    await user.save();

    res.status(200).json({
      message: "Minimum match score updated successfully",
    });
  }
);

// @desc Resets a user's account to its initial state
// @route POST /api/users/factory-reset
// @access Private
export const factoryResetUserAccount = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    user.resume = {
      skills: [],
      experience: [],
      education: [],
      summary: "",
      certifications: [],
      languages: [],
      projects: [],
      achievements: [],
      volunteerExperience: [],
      interests: [],
    };
    user.preferences = {
      jobTypes: [],
      location: [],
      remoteOnly: false,
      minSalary: 0,
      industries: [],
      minScore: 30,
    };
    user.skippedJobs = [];
    user.qna = [];
    await user.save();
    await deleteAllMatches(userId);
    // todo: we should reset any usage metrics in the future if any

    res.status(200).json({
      message: "User account reset successfully",
    });
  }
);

// @desc    Delete user account
// @route   DELETE /api/users/delete
// @access  Private
export const deleteUserAccount = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    await deleteAllMatches(userId);
    await User.findByIdAndDelete(userId);

    res.status(200).json({
      message: "User account deleted successfully",
    });
  }
);
