import { Request, Response, NextFunction } from "express";
import multer from "multer";
import { captureCvUploadAttempt } from "../services/analyticsService";
import { UNSUPPORTED_TYPE_MESSAGE } from "./fileUpload";

const reject = (
  req: Request,
  res: Response,
  status: number,
  outcome: "too_large" | "unsupported_type",
  message: string
) => {
  const userId = req.user?.id;
  if (userId) {
    captureCvUploadAttempt(String(userId), { outcome, reason: outcome, retryable: false });
  }
  res.status(status).json({ success: false, code: outcome, retryable: false, message });
};

/**
 * Error middleware for the POST /cv route: maps multer / file-filter errors to 4xx
 * (instead of falling through to the generic errorHandler as a 500).
 */
export const cvUploadErrorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return reject(req, res, 413, "too_large", "That file is too large. Please upload a file under 10 MB.");
    }
    return reject(req, res, 400, "unsupported_type", UNSUPPORTED_TYPE_MESSAGE);
  }
  if (err instanceof Error && err.message === UNSUPPORTED_TYPE_MESSAGE) {
    return reject(req, res, 400, "unsupported_type", UNSUPPORTED_TYPE_MESSAGE);
  }
  return next(err);
};
