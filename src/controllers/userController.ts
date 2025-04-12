import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import bcrypt from "bcrypt";

import User from "../models/User";
import { findUserByEmail } from "../services/userService";
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

// @desc    Register a new user
// @route   POST /api/users/register
// @access  Public
export const registerUser = asyncHandler(
  async (req: Request, res: Response) => {
    const { name, email, password } = req.body;

    // Check if user exists
    // Hash password
    // Create user
    // TODO: Implement user registration logic

    res.status(201).json({
      message: "User registered successfully",
    });
  }
);

// @desc    Authenticate user & get token
// @route   POST /api/users/login
// @access  Public
export const loginUser = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  // TODO: Implement login logic

  res.json({
    message: "Login successful",
  });
});

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
export const getUserProfile = asyncHandler(
  async (req: Request, res: Response) => {
    // TODO: Implement get profile logic
    res.json({
      message: "User profile retrieved",
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
