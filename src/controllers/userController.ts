import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import bcrypt from "bcrypt";
import path from "path";
import fs from "fs";

import User from "../models/User";
import {
  answerQuestion,
  findUserByEmail,
  getAIQuestion,
  getUserNameById,
  parseUserCV,
} from "../services/userService";
import { generateToken } from "../utils/generateToken";

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
