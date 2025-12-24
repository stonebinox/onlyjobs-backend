import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import User from "../models/User";
import Transaction from "../models/Transaction";
import {
  createOrder,
  verifyPayment,
  verifyWebhookSignature,
  fetchOrder,
} from "../services/razorpayService";

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

/**
 * Cancel a payment order (client-side cancellation)
 * Called when user closes the payment modal or cancels
 */
export const cancelPaymentOrder = asyncHandler(
  async (req: Request, res: Response) => {
    const { orderId, reason } = req.body;
    const userId = req.user._id;

    if (!orderId) {
      res.status(400);
      throw new Error("Order ID is required");
    }

    const transaction = await Transaction.findOne({
      userId,
      razorpayOrderId: orderId,
      status: "pending",
    });

    if (!transaction) {
      // Transaction might already be processed or doesn't exist
      // Return success anyway to avoid client-side errors
      res.json({
        success: true,
        message: "Transaction not found or already processed",
      });
      return;
    }

    transaction.status = "failed";
    transaction.metadata = {
      ...transaction.metadata,
      failedAt: new Date(),
      failureReason: reason || "User cancelled payment",
      cancelledBy: "client",
    };
    await transaction.save();

    res.json({
      success: true,
      message: "Payment cancelled successfully",
    });
  }
);

/**
 * Handle payment failure from client
 * Called when Razorpay returns a payment failure
 */
export const handlePaymentFailure = asyncHandler(
  async (req: Request, res: Response) => {
    const { orderId, errorCode, errorDescription, errorReason } = req.body;
    const userId = req.user._id;

    if (!orderId) {
      res.status(400);
      throw new Error("Order ID is required");
    }

    const transaction = await Transaction.findOne({
      userId,
      razorpayOrderId: orderId,
      status: "pending",
    });

    if (!transaction) {
      res.json({
        success: true,
        message: "Transaction not found or already processed",
      });
      return;
    }

    transaction.status = "failed";
    transaction.metadata = {
      ...transaction.metadata,
      failedAt: new Date(),
      failureReason: errorDescription || "Payment failed",
      errorCode,
      errorReason,
      cancelledBy: "razorpay_client",
    };
    await transaction.save();

    res.json({
      success: true,
      message: "Payment failure recorded",
    });
  }
);

/**
 * Razorpay Webhook Handler
 * Handles events from Razorpay for robust payment status tracking
 * Events handled: payment.captured, payment.failed, order.paid
 */
export const handleRazorpayWebhook = asyncHandler(
  async (req: Request, res: Response) => {
    const signature = req.headers["x-razorpay-signature"] as string;

    if (!signature) {
      console.error("Webhook received without signature");
      res.status(400);
      throw new Error("Missing webhook signature");
    }

    // Get raw body for signature verification
    // Note: This requires raw body middleware to be set up
    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    // Verify webhook signature
    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      console.error("Invalid webhook signature");
      res.status(400);
      throw new Error("Invalid webhook signature");
    }

    const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const eventType = event.event;
    const payload = event.payload;

    console.log(`Razorpay webhook received: ${eventType}`);

    try {
      switch (eventType) {
        case "payment.captured":
        case "order.paid": {
          // Payment successful - ensure transaction is marked as completed
          const orderId =
            payload.payment?.entity?.order_id || payload.order?.entity?.id;
          const paymentId = payload.payment?.entity?.id;

          if (!orderId) {
            console.error("Webhook missing order ID");
            break;
          }

          const transaction = await Transaction.findOne({
            razorpayOrderId: orderId,
          });

          if (!transaction) {
            console.error(`Transaction not found for order: ${orderId}`);
            break;
          }

          // Only update if not already completed (idempotency)
          if (transaction.status !== "completed") {
            transaction.status = "completed";
            transaction.razorpayPaymentId =
              paymentId || transaction.razorpayPaymentId;
            transaction.metadata = {
              ...transaction.metadata,
              webhookConfirmedAt: new Date(),
              webhookEvent: eventType,
            };
            await transaction.save();

            // Credit wallet if not already done
            const user = await User.findById(transaction.userId);
            if (user) {
              // Check if wallet was already credited by checking metadata
              if (!transaction.metadata?.walletCredited) {
                user.walletBalance =
                  (user.walletBalance || 0) + transaction.amount;
                await user.save();

                transaction.metadata = {
                  ...transaction.metadata,
                  walletCredited: true,
                  walletCreditedAt: new Date(),
                };
                await transaction.save();

                console.log(
                  `Wallet credited via webhook for user ${user._id}: $${transaction.amount}`
                );
              }
            }
          }
          break;
        }

        case "payment.failed": {
          // Payment failed - mark transaction as failed
          const orderId = payload.payment?.entity?.order_id;
          const errorCode = payload.payment?.entity?.error_code;
          const errorDescription = payload.payment?.entity?.error_description;
          const errorReason = payload.payment?.entity?.error_reason;

          if (!orderId) {
            console.error("Webhook missing order ID for failed payment");
            break;
          }

          const transaction = await Transaction.findOne({
            razorpayOrderId: orderId,
            status: "pending",
          });

          if (transaction) {
            transaction.status = "failed";
            transaction.metadata = {
              ...transaction.metadata,
              failedAt: new Date(),
              failureReason: errorDescription || "Payment failed",
              errorCode,
              errorReason,
              cancelledBy: "razorpay_webhook",
              webhookEvent: eventType,
            };
            await transaction.save();

            console.log(`Payment marked as failed via webhook: ${orderId}`);
          }
          break;
        }

        default:
          console.log(`Unhandled webhook event: ${eventType}`);
      }

      // Always return 200 to acknowledge receipt
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Error processing webhook:", error);
      // Still return 200 to prevent Razorpay from retrying
      // Log the error for manual investigation
      res.status(200).json({ received: true, error: "Processing error logged" });
    }
  }
);

/**
 * Sync transaction status with Razorpay
 * Called to verify/update a specific transaction's status
 */
export const syncTransactionStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const { orderId } = req.params;
    const userId = req.user._id;

    if (!orderId) {
      res.status(400);
      throw new Error("Order ID is required");
    }

    const transaction = await Transaction.findOne({
      userId,
      razorpayOrderId: orderId,
    });

    if (!transaction) {
      res.status(404);
      throw new Error("Transaction not found");
    }

    // If already completed or failed, return current status
    if (transaction.status !== "pending") {
      res.json({
        status: transaction.status,
        message: `Transaction is ${transaction.status}`,
      });
      return;
    }

    // Fetch order status from Razorpay
    const order = await fetchOrder(orderId);

    if (!order) {
      res.status(500);
      throw new Error("Failed to fetch order status from Razorpay");
    }

    // Update based on Razorpay order status
    // Razorpay order statuses: created, attempted, paid
    if (order.status === "paid") {
      // Order is paid but we haven't processed it yet
      // This shouldn't happen normally, but handle it
      transaction.status = "completed";
      transaction.metadata = {
        ...transaction.metadata,
        syncedAt: new Date(),
        razorpayStatus: order.status,
      };
      await transaction.save();

      // Credit wallet
      const user = await User.findById(userId);
      if (user && !transaction.metadata?.walletCredited) {
        user.walletBalance = (user.walletBalance || 0) + transaction.amount;
        await user.save();

        transaction.metadata = {
          ...transaction.metadata,
          walletCredited: true,
          walletCreditedAt: new Date(),
        };
        await transaction.save();
      }

      res.json({
        status: "completed",
        message: "Transaction synced and completed",
        newBalance: user?.walletBalance,
      });
    } else {
      // Order is still pending or attempted
      res.json({
        status: "pending",
        razorpayStatus: order.status,
        message: "Transaction is still pending",
      });
    }
  }
);

// Stale transaction expiry time (30 minutes)
const STALE_TRANSACTION_MINUTES = 30;

/**
 * Clean up stale pending transactions
 * Marks transactions as failed if they've been pending for too long
 * This is called by a cron job
 */
export const cleanupStalePendingTransactions = async (): Promise<void> => {
  const staleThreshold = new Date(
    Date.now() - STALE_TRANSACTION_MINUTES * 60 * 1000
  );

  try {
    // Find all stale pending transactions
    const staleTxns = await Transaction.find({
      status: "pending",
      type: "credit", // Only credit transactions (top-ups) have Razorpay orders
      createdAt: { $lt: staleThreshold },
    });

    console.log(`Found ${staleTxns.length} stale pending transactions to check`);

    for (const txn of staleTxns) {
      try {
        // Verify with Razorpay before marking as failed
        if (txn.razorpayOrderId) {
          const order = await fetchOrder(txn.razorpayOrderId);

          if (order?.status === "paid") {
            // Order was actually paid - complete the transaction
            txn.status = "completed";
            txn.metadata = {
              ...txn.metadata,
              recoveredAt: new Date(),
              razorpayStatus: order.status,
              recoveryNote: "Recovered during stale transaction cleanup",
            };
            await txn.save();

            // Credit wallet
            const user = await User.findById(txn.userId);
            if (user && !txn.metadata?.walletCredited) {
              user.walletBalance = (user.walletBalance || 0) + txn.amount;
              await user.save();

              txn.metadata = {
                ...txn.metadata,
                walletCredited: true,
                walletCreditedAt: new Date(),
              };
              await txn.save();

              console.log(
                `Recovered stale transaction ${txn._id} for user ${user._id}: $${txn.amount}`
              );
            }
            continue;
          }
        }

        // Mark as failed/expired
        txn.status = "failed";
        txn.metadata = {
          ...txn.metadata,
          failedAt: new Date(),
          failureReason: "Transaction expired (no payment received)",
          cancelledBy: "system_cleanup",
        };
        await txn.save();

        console.log(`Marked stale transaction ${txn._id} as failed`);
      } catch (error) {
        console.error(`Error processing stale transaction ${txn._id}:`, error);
      }
    }

    console.log("Stale transaction cleanup completed");
  } catch (error) {
    console.error("Error during stale transaction cleanup:", error);
  }
};

