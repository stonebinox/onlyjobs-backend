import { cleanupStalePendingTransactions } from "../controllers/walletController";

/**
 * Run stale transaction cleanup job
 * This job finds pending transactions that have been sitting for too long
 * and verifies their status with Razorpay before marking them as failed
 */
const runTransactionCleanup = async (): Promise<void> => {
  console.log("Starting stale transaction cleanup job...");
  const startTime = Date.now();

  try {
    await cleanupStalePendingTransactions();
    const duration = Date.now() - startTime;
    console.log(`Transaction cleanup completed in ${duration}ms`);
  } catch (error) {
    console.error("Transaction cleanup job failed:", error);
  }
};

export default runTransactionCleanup;

