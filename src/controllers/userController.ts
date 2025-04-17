import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import bcrypt from "bcrypt";

import User from "../models/User";
import { findUserByEmail, getUserNameById } from "../services/userService";
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

// @desc    Upload and parse user resume
// @route   POST /api/users/resume
// @access  Private
export const uploadResume = asyncHandler(
  async (req: Request, res: Response) => {
    // TODO: Implement resume upload and parsing with OpenAI
    res.json({
      message: "Resume uploaded and parsed",
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

// @desc    Get user's job matches
// @route   GET /api/users/matches
// @access  Private
export const getMatches = asyncHandler(async (req: Request, res: Response) => {
  // TODO: Implement getting matches logic
  res.json({
    message: "Job matches retrieved",
  });
});
