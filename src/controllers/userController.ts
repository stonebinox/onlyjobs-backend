import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import User from "../models/User";
import MatchRecord from "../models/MatchRecord";
import mongoose from "mongoose";

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
