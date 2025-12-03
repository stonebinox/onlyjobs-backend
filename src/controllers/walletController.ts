import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import User from "../models/User";
import Transaction from "../models/Transaction";
import { createOrder, verifyPayment } from "../services/razorpayService";

/**
 * Get current wallet balance for authenticated user
 */
export const getWalletBalance = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    res.json({
      balance: user.walletBalance || 0,
    });
  }
);

/**
 * Create a Razorpay payment order
 */
export const createPaymentOrder = asyncHandler(
  async (req: Request, res: Response) => {
    const { amount } = req.body;
    const userId = req.user._id;

    // Validate amount
    if (!amount || typeof amount !== "number" || amount < 5 || amount > 500) {
      res.status(400);
      throw new Error("Amount must be between $5 and $500");
    }

    // Check if amount is an integer (no decimals)
    if (amount % 1 !== 0) {
      res.status(400);
      throw new Error("Amount must be a whole number (no decimals)");
    }

    try {
      // Generate receipt ID (max 40 chars for Razorpay)
      // Format: "wlt_<userId_last12chars>_<timestamp_last8chars>" = max 40 chars
      const userIdStr = userId.toString();
      const shortUserId = userIdStr.slice(-12);
      const timestamp = Date.now().toString().slice(-8);
      const receipt = `wlt_${shortUserId}_${timestamp}`;

      const order = await createOrder(amount, receipt);

      // Create pending transaction record
      await Transaction.create({
        userId,
        type: "credit",
        amount,
        description: `Wallet top-up - $${amount}`,
        razorpayOrderId: order.id,
        status: "pending",
        metadata: {
          orderDetails: order,
        },
      });

      res.json({
        orderId: order.id,
        amount: order.amount / 100, // Convert back to USD
        currency: order.currency,
      });
    } catch (error) {
      console.error("Error creating payment order:", error);
      res.status(500);
      throw new Error("Failed to create payment order");
    }
  }
);

/**
 * Verify payment and credit wallet
 */
export const verifyAndCreditWallet = asyncHandler(
  async (req: Request, res: Response) => {
    const { orderId, paymentId, signature } = req.body;
    const userId = req.user._id;

    if (!orderId || !paymentId || !signature) {
      res.status(400);
      throw new Error("Missing payment details");
    }

    // Verify payment signature
    const isValid = verifyPayment(orderId, paymentId, signature);
    if (!isValid) {
      res.status(400);
      throw new Error("Invalid payment signature");
    }

    // Find pending transaction
    const transaction = await Transaction.findOne({
      userId,
      razorpayOrderId: orderId,
      status: "pending",
    });

    if (!transaction) {
      res.status(404);
      throw new Error("Transaction not found or already processed");
    }

    // Update transaction with payment details
    transaction.razorpayPaymentId = paymentId;
    transaction.razorpaySignature = signature;
    transaction.status = "completed";
    transaction.metadata = {
      ...transaction.metadata,
      paymentId,
      verifiedAt: new Date(),
    };
    await transaction.save();

    // Credit wallet
    const user = await User.findById(userId);
    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    user.walletBalance = (user.walletBalance || 0) + transaction.amount;
    await user.save();

    res.json({
      success: true,
      message: "Payment verified and wallet credited",
      newBalance: user.walletBalance,
    });
  }
);

/**
 * Get transaction history for authenticated user
 */
export const getTransactions = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user._id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const transactions = await Transaction.find({ userId })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .select("-razorpaySignature -metadata");

    const total = await Transaction.countDocuments({ userId });

    res.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

/**
 * Check if user has sufficient balance (helper function for job matching)
 */
export const checkBalance = async (userId: string): Promise<boolean> => {
  const user = await User.findById(userId);
  if (!user) {
    return false;
  }
  return (user.walletBalance || 0) >= 0.3;
};

