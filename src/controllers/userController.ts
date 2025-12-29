import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import bcrypt from "bcrypt";
import path from "path";
import fs from "fs";
import { tmpdir } from "os";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

import User, { IUser } from "../models/User";
import Transaction from "../models/Transaction";
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
import {
  sendEmailChangeVerificationEmail,
  sendInitialVerificationEmail,
  sendMatchingEnabledEmail,
  sendMatchingDisabledEmail,
  sendAdminUserVerifiedEmail,
  sendPasswordResetEmail,
} from "../services/emailService";

const saltRounds = 10;

const validateStringArray = (fieldName: string, value: unknown) => {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }

  const allStrings = value.every((item) => typeof item === "string");
  if (!allStrings) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
};

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
      // we create the user with $2 welcome bonus
      const WELCOME_BONUS = 2;
      
      // Generate verification token for new users
      const verificationToken = crypto.randomBytes(32).toString("hex");
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
      
      user = await User.create({
        email,
        password: encryptedPassword,
        lastLoginAt: new Date(),
        walletBalance: WELCOME_BONUS,
        emailVerificationToken: verificationToken,
        emailVerificationExpires: verificationExpires,
        isVerified: false,
      });

      // Create a transaction record for the welcome bonus
      await Transaction.create({
        userId: user._id,
        type: "credit",
        amount: WELCOME_BONUS,
        description: "Welcome bonus - free credits to get started",
        status: "completed",
        metadata: {
          type: "welcome_bonus",
        },
      });

      // Send verification email to new user
      await sendInitialVerificationEmail(user.email, verificationToken);
    } else {
      // we check if the password is correct
      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        res.status(401);
        throw new Error("Invalid email or password");
      }

      // Update last login timestamp
      user.lastLoginAt = new Date();
      await user.save();
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
    let matchRecordId: string | null = null;

    if (req.body.jobResultId) {
      const jobResultId = req.body.jobResultId;
      let jobResult = await MatchRecord.findById(jobResultId);

      if (!jobResult) {
        jobResult = null;
      } else {
        matchRecordId = jobResultId;
        const jobId = jobResult.jobId;
        jobDetails = (await JobListing.findById(
          jobId.toString()
        )) as IJobListing | null;
      }
    }

    try {
      const answer = await getAnswerForQuestion(
        user,
        question,
        jobDetails,
        matchRecordId || undefined
      );

      if (!answer) {
        res.status(200).json({
          success: false,
          message: "Invalid answer",
        });

        return;
      }

      // Save Q&A pair to database if matchRecordId is provided
      if (matchRecordId) {
        await MatchRecord.findByIdAndUpdate(
          matchRecordId,
          {
            $push: {
              qna: {
                question: question.trim(),
                answer,
                createdAt: new Date(),
              },
            },
          },
          { new: true }
        );
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

// @desc    Get Q&A history for a match
// @route   GET /api/users/match-qna/:matchRecordId
// @access  Private
export const getMatchQnAHistory = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const { matchRecordId } = req.params;

    if (!matchRecordId) {
      res.status(400);
      throw new Error("Match record ID is required");
    }

    // Verify the match record belongs to the user
    const matchRecord = await MatchRecord.findById(matchRecordId);

    if (!matchRecord) {
      res.status(404);
      throw new Error("Match record not found");
    }

    if (matchRecord.userId.toString() !== userId) {
      res.status(403);
      throw new Error("Not authorized to access this match record");
    }

    try {
      // Sort Q&A by creation date (newest first) and format for response
      const qnaHistory = (matchRecord.qna || [])
        .sort((a, b) => {
          const dateA = a.createdAt || new Date(0);
          const dateB = b.createdAt || new Date(0);
          return dateB.getTime() - dateA.getTime();
        })
        .map((qa, index) => ({
          _id: `qna-${index}`, // Generate a simple ID for frontend
          question: qa.question,
          answer: qa.answer,
          createdAt: qa.createdAt || matchRecord.createdAt,
          updatedAt: qa.createdAt || matchRecord.updatedAt,
        }));

      res.status(200).json({
        success: true,
        qnaHistory,
      });
    } catch (e) {
      console.error("Error fetching Q&A history:", e);
      res.status(500);
      throw new Error("Error fetching Q&A history");
    }
  }
);

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
export const updateUserProfile = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const { resume } = req.body;

    if (!resume || typeof resume !== "object") {
      res.status(400);
      throw new Error("Please provide valid resume data");
    }

    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    // Merge resume updates with existing resume data
    const updatedResume = {
      ...user.resume,
      ...resume,
    };

    // Validate array fields are arrays
    const arrayFields = [
      "skills",
      "experience",
      "education",
      "projects",
      "certifications",
      "languages",
      "achievements",
      "volunteerExperience",
      "interests",
    ];

    for (const field of arrayFields) {
      if (resume[field] !== undefined) {
        if (!Array.isArray(resume[field])) {
          res.status(400);
          throw new Error(`${field} must be an array`);
        }
        updatedResume[field] = resume[field];
      }
    }

    // Validate summary is a string if provided
    if (resume.summary !== undefined && typeof resume.summary !== "string") {
      res.status(400);
      throw new Error("summary must be a string");
    }

    // Update user with merged resume data
    user.resume = updatedResume as IUser["resume"];
    await user.save();

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
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

    const guideProgress = user.guideProgress || {};
    const progressMap: {
      [pageId: string]: {
        completed: boolean;
        completedAt?: Date;
        skipped: boolean;
        skippedAt?: Date;
      };
    } = {};

    // Convert Map to object if it exists
    if (guideProgress instanceof Map) {
      guideProgress.forEach((value, key) => {
        progressMap[key] = {
          completed: value.completed || false,
          completedAt: value.completedAt,
          skipped: value.skipped || false,
          skippedAt: value.skippedAt,
        };
      });
    } else if (typeof guideProgress === "object") {
      Object.assign(progressMap, guideProgress);
    }

    res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        preferences: user.preferences,
        resume: user.resume,
        createdAt: user.createdAt,
        guideProgress: progressMap,
        isVerified: user.isVerified,
        answeredQuestionsCount: user.qna?.filter(q => !q.skipped && q.answer).length || 0,
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

// @desc    Update user preferences (location, remoteOnly, minSalary, jobTypes, industries, minScore)
// @route   PUT /api/users/preferences
// @access  Private
export const updatePreferences = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const { location, remoteOnly, minSalary, jobTypes, industries, minScore } =
      req.body;

    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    try {
      if (location !== undefined) {
        validateStringArray("location", location);
        user.preferences.location = location;
      }

      if (remoteOnly !== undefined) {
        if (typeof remoteOnly !== "boolean") {
          res.status(400);
          throw new Error("remoteOnly must be a boolean");
        }
        user.preferences.remoteOnly = remoteOnly;
      }

      if (minSalary !== undefined) {
        const parsedMinSalary = Number(minSalary);
        if (Number.isNaN(parsedMinSalary) || parsedMinSalary < 0) {
          res.status(400);
          throw new Error("minSalary must be a non-negative number");
        }
        user.preferences.minSalary = parsedMinSalary;
      }

      if (jobTypes !== undefined) {
        validateStringArray("jobTypes", jobTypes);
        user.preferences.jobTypes = jobTypes;
      }

      if (industries !== undefined) {
        validateStringArray("industries", industries);
        user.preferences.industries = industries;
      }

      if (minScore !== undefined) {
        const parsedMinScore = Number(minScore);
        if (
          Number.isNaN(parsedMinScore) ||
          parsedMinScore < 0 ||
          parsedMinScore > 100
        ) {
          res.status(400);
          throw new Error("minScore must be between 0 and 100");
        }
        user.preferences.minScore = parsedMinScore;
      }

      if (req.body.matchingEnabled !== undefined) {
        if (typeof req.body.matchingEnabled !== "boolean") {
          res.status(400);
          throw new Error("matchingEnabled must be a boolean");
        }
        const previousMatchingEnabled =
          user.preferences.matchingEnabled ?? true;
        const newMatchingEnabled = req.body.matchingEnabled;

        user.preferences.matchingEnabled = newMatchingEnabled;

        // Send email if matching status changed
        if (previousMatchingEnabled !== newMatchingEnabled) {
          // Reload user after save to get fresh data, then send email
          await user.save();
          const updatedUser = await User.findById(userId);
          if (updatedUser) {
            if (newMatchingEnabled) {
              // Matching enabled - send welcome back email
              try {
                await sendMatchingEnabledEmail(updatedUser);
              } catch (err) {
                console.error("Failed to send matching enabled email", err);
                // Don't fail the request if email fails
              }
            } else {
              // Matching disabled - send confirmation email
              try {
                await sendMatchingDisabledEmail(updatedUser);
              } catch (err) {
                console.error("Failed to send matching disabled email", err);
                // Don't fail the request if email fails
              }
            }
          }
        } else {
          await user.save();
        }
      } else {
        await user.save();
      }

      // Reload user to get latest state
      const finalUser = await User.findById(userId);
      if (!finalUser) {
        res.status(404);
        throw new Error("User not found");
      }

      res.status(200).json({
        message: "Preferences updated successfully",
        preferences: finalUser.preferences,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Invalid preferences payload");
    }
  }
);

// @desc    Request email change (sends verification to new email)
// @route   POST /api/users/email-change/request
// @access  Private
export const requestEmailChange = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const { newEmail } = req.body;

    if (!newEmail || typeof newEmail !== "string" || newEmail.trim() === "") {
      res.status(400);
      throw new Error("Please provide a valid new email");
    }

    const normalizedNewEmail = newEmail.trim().toLowerCase();

    // Check if another account already uses this email (active or pending)
    const existingUser = await User.findOne({
      $or: [
        { email: normalizedNewEmail },
        { pendingEmail: normalizedNewEmail },
      ],
    });
    if (existingUser) {
      res.status(409);
      throw new Error("Another account already uses this email");
    }

    const user = await User.findById(userId);
    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    user.pendingEmail = normalizedNewEmail;
    user.emailVerificationToken = token;
    user.emailVerificationExpires = expires;

    await user.save();

    await sendEmailChangeVerificationEmail(
      user.email,
      normalizedNewEmail,
      token
    );

    res.status(200).json({
      message:
        "Verification email sent to the new address. Please verify to complete the change.",
      shouldLogout: true,
    });
  }
);

// @desc    Verify email change (one-time token)
// @route   POST /api/users/email-change/verify
// @access  Public
export const verifyEmailChange = asyncHandler(
  async (req: Request, res: Response) => {
    const { token } = req.body;

    if (!token || typeof token !== "string") {
      res.status(400);
      throw new Error("Verification token is required");
    }

    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      res.status(400);
      throw new Error("Invalid or expired verification link");
    }

    // Ensure no other user took this email in the meantime
    if (user.pendingEmail) {
      const conflict = await User.findOne({
        email: user.pendingEmail,
        _id: { $ne: user._id },
      });
      if (conflict) {
        // Clear pending fields to prevent reuse
        user.pendingEmail = undefined;
        user.emailVerificationToken = undefined;
        user.emailVerificationExpires = undefined;
        await user.save();
        res.status(409);
        throw new Error("Another account already uses this email");
      }
    }

    // Apply email change
    if (!user.pendingEmail) {
      res.status(400);
      throw new Error("No pending email change found");
    }

    user.email = user.pendingEmail;
    user.pendingEmail = undefined;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    user.isVerified = true;
    await user.save();

    // Send admin notification (non-blocking)
    sendAdminUserVerifiedEmail(user.email, true).catch((err) => {
      console.error("[EMAIL] Failed to send admin notification:", err);
    });

    res.status(200).json({
      message: "Email updated successfully. Please sign in again.",
      shouldLogout: true,
    });
  }
);

// @desc    Resend initial email verification
// @route   POST /api/users/resend-verification
// @access  Private
export const resendVerificationEmail = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    if (user.isVerified) {
      res.status(400);
      throw new Error("Email is already verified");
    }

    // Generate verification token
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Clear pendingEmail since we're verifying the current email, not changing it
    user.emailVerificationToken = token;
    user.emailVerificationExpires = expires;
    user.pendingEmail = undefined;
    await user.save();

    const emailSent = await sendInitialVerificationEmail(user.email, token);

    if (!emailSent) {
      res.status(500);
      throw new Error("Failed to send verification email. Please try again later.");
    }

    res.status(200).json({
      message: "Verification email sent. Please check your inbox.",
    });
  }
);

// @desc    Verify initial email (one-time token)
// @route   POST /api/users/verify-email
// @access  Public
export const verifyInitialEmail = asyncHandler(
  async (req: Request, res: Response) => {
    const { token } = req.body;

    if (!token || typeof token !== "string") {
      res.status(400);
      throw new Error("Verification token is required");
    }

    // Find user by token - for initial verification, pendingEmail should be null/undefined
    // (email changes will have pendingEmail set and use the email-change/verify endpoint)
    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
      $or: [
        { pendingEmail: { $exists: false } },
        { pendingEmail: null },
      ],
    });

    if (!user) {
      res.status(400);
      throw new Error("Invalid or expired verification link");
    }

    // Mark email as verified
    user.isVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    // Send admin notification (non-blocking)
    sendAdminUserVerifiedEmail(user.email, false).catch((err) => {
      console.error("[EMAIL] Failed to send admin notification:", err);
    });

    res.status(200).json({
      message: "Email verified successfully.",
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
      matchingEnabled: true,
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

// @desc    Search existing skills across all users
// @route   GET /api/users/skills/search?q=query
// @access  Private
export const searchSkills = asyncHandler(
  async (req: Request, res: Response) => {
    const query = req.query.q as string;

    if (!query || query.trim().length < 2) {
      res.status(200).json({
        skills: [],
      });
      return;
    }

    const searchTerm = query.trim().toLowerCase();

    // Get all users and extract unique skills
    const users = await User.find({
      "resume.skills": { $exists: true, $ne: [] },
    }).select("resume.skills");

    // Extract all skills and normalize them (remove ratings for matching)
    const skillSet = new Set<string>();
    users.forEach((user) => {
      if (user.resume?.skills) {
        user.resume.skills.forEach((skill: string) => {
          // Extract skill name without rating: "JavaScript (8)" -> "JavaScript"
          const skillName = skill.replace(/\s*\(\d+\/10\)\s*$/, "").trim();
          if (skillName.toLowerCase().includes(searchTerm)) {
            skillSet.add(skillName);
          }
        });
      }
    });

    // Convert to array and sort
    const skills = Array.from(skillSet).sort();

    res.status(200).json({
      skills: skills.slice(0, 10), // Limit to 10 results
    });
  }
);

// @desc    Get user guide progress
// @route   GET /api/users/guide-progress
// @access  Private
export const getGuideProgress = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    const guideProgress = user.guideProgress || {};
    const progressMap: {
      [pageId: string]: {
        completed: boolean;
        completedAt?: Date;
        skipped: boolean;
        skippedAt?: Date;
      };
    } = {};

    // Convert Map to object if it exists
    if (guideProgress instanceof Map) {
      guideProgress.forEach((value, key) => {
        progressMap[key] = {
          completed: value.completed || false,
          completedAt: value.completedAt,
          skipped: value.skipped || false,
          skippedAt: value.skippedAt,
        };
      });
    } else if (typeof guideProgress === "object") {
      Object.assign(progressMap, guideProgress);
    }

    res.status(200).json({
      guideProgress: progressMap,
    });
  }
);

// @desc    Update user guide progress
// @route   PUT /api/users/guide-progress
// @access  Private
export const updateGuideProgress = asyncHandler(
  async (req: Request, res: Response) => {
    const { pageId, completed, skipped } = req.body;

    if (!pageId || typeof pageId !== "string") {
      res.status(400);
      throw new Error("Please provide a valid pageId");
    }

    if (completed === undefined && skipped === undefined) {
      res.status(400);
      throw new Error("Please provide either completed or skipped status");
    }

    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    // Initialize guideProgress if it doesn't exist
    if (!user.guideProgress) {
      user.guideProgress = new Map();
    }

    // Get current progress for this page
    const currentProgress = user.guideProgress.get(pageId) || {
      completed: false,
      skipped: false,
    };

    // Update progress
    const updatedProgress = {
      completed:
        completed !== undefined ? completed : currentProgress.completed,
      completedAt:
        completed && !currentProgress.completed
          ? new Date()
          : currentProgress.completedAt,
      skipped: skipped !== undefined ? skipped : currentProgress.skipped,
      skippedAt:
        skipped && !currentProgress.skipped
          ? new Date()
          : currentProgress.skippedAt,
    };

    user.guideProgress.set(pageId, updatedProgress);
    await user.save();

    res.status(200).json({
      message: "Guide progress updated successfully",
      guideProgress: {
        [pageId]: updatedProgress,
      },
    });
  }
);

// @desc    Reset user guide progress
// @route   POST /api/users/guide-progress/reset
// @access  Private
export const resetGuideProgress = asyncHandler(
  async (req: Request, res: Response) => {
    const { pageId } = req.body;

    const userId = req.user?.id;
    const user = await User.findById(userId);

    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    if (pageId) {
      // Reset specific page
      if (user.guideProgress) {
        user.guideProgress.delete(pageId);
        await user.save();
      }
      res.status(200).json({
        message: `Guide progress reset for page: ${pageId}`,
      });
    } else {
      // Reset all pages
      user.guideProgress = new Map();
      await user.save();
      res.status(200).json({
        message: "All guide progress reset successfully",
      });
    }
  }
);

// @desc    Request password reset (forgot password)
// @route   POST /api/users/forgot-password
// @access  Public
export const requestPasswordReset = asyncHandler(
  async (req: Request, res: Response) => {
    const { email } = req.body;

    if (!email || typeof email !== "string" || email.trim() === "") {
      res.status(400);
      throw new Error("Please provide a valid email address");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await findUserByEmail(normalizedEmail);

    // Always return success to prevent email enumeration attacks
    // Even if user doesn't exist, we pretend we sent the email
    if (user) {
      // Generate a password reset token
      const resetToken = crypto.randomBytes(32).toString("hex");
      const hashedToken = crypto
        .createHash("sha256")
        .update(resetToken)
        .digest("hex");

      // Set token and expiration (1 hour)
      user.passwordResetToken = hashedToken;
      user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
      await user.save();

      // Send password reset email (non-blocking)
      sendPasswordResetEmail(user.email, resetToken).catch((err) => {
        console.error("[PASSWORD_RESET] Failed to send email:", err);
      });
    }

    res.status(200).json({
      message:
        "If an account with that email exists, you will receive a password reset link shortly.",
    });
  }
);

// @desc    Reset password with token
// @route   POST /api/users/reset-password
// @access  Public
export const resetPasswordWithToken = asyncHandler(
  async (req: Request, res: Response) => {
    const { token, newPassword } = req.body;

    if (!token || typeof token !== "string") {
      res.status(400);
      throw new Error("Reset token is required");
    }

    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
      res.status(400);
      throw new Error("Password must be at least 8 characters long");
    }

    // Hash the token to compare with stored hash
    const hashedToken = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    // Find user with valid token that hasn't expired
    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() },
    });

    if (!user) {
      res.status(400);
      throw new Error("Invalid or expired reset token");
    }

    // Update password and clear reset token fields
    user.password = await bcrypt.hash(newPassword, saltRounds);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    res.status(200).json({
      message: "Password reset successfully. You can now log in with your new password.",
    });
  }
);
