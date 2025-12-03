import express from "express";
import {
  getWalletBalance,
  createPaymentOrder,
  verifyAndCreditWallet,
  getTransactions,
} from "../controllers/walletController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

// All routes are protected
router.get("/balance", protect, getWalletBalance);
router.post("/create-order", protect, createPaymentOrder);
router.post("/verify-payment", protect, verifyAndCreditWallet);
router.get("/transactions", protect, getTransactions);

export default router;

