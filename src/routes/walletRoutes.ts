import express from "express";
import {
  getWalletBalance,
  createPaymentOrder,
  verifyAndCreditWallet,
  getTransactions,
  cancelPaymentOrder,
  handlePaymentFailure,
  recordFailureAttempt,
  handleRazorpayWebhook,
  syncTransactionStatus,
} from "../controllers/walletController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

// Webhook route - NO auth, uses Razorpay signature verification
// Must use raw body for signature verification
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  handleRazorpayWebhook
);

// Protected routes
router.get("/balance", protect, getWalletBalance);
router.post("/create-order", protect, createPaymentOrder);
router.post("/verify-payment", protect, verifyAndCreditWallet);
router.get("/transactions", protect, getTransactions);

// Payment failure handling routes
router.post("/cancel-order", protect, cancelPaymentOrder);
router.post("/payment-failed", protect, handlePaymentFailure);
router.post("/record-failure-attempt", protect, recordFailureAttempt);

// Transaction sync route - for manual verification
router.get("/sync/:orderId", protect, syncTransactionStatus);

export default router;

