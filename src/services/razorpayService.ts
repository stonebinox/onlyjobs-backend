import Razorpay from "razorpay";
import crypto from "crypto";

// Lazy initialization of Razorpay instance
let razorpayInstance: Razorpay | null = null;

const getRazorpayInstance = (): Razorpay => {
  if (!razorpayInstance) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      throw new Error(
        "Razorpay credentials not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables."
      );
    }

    razorpayInstance = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
  }

  return razorpayInstance;
};

export interface RazorpayOrderResponse {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: string;
  created_at: number;
}

/**
 * Create a Razorpay order for the given amount
 * @param amount Amount in USD (will be converted to cents/paise)
 * @param receipt Receipt identifier
 * @returns Razorpay order object
 */
export const createOrder = async (
  amount: number,
  receipt?: string
): Promise<RazorpayOrderResponse> => {
  try {
    const razorpay = getRazorpayInstance();

    // Convert USD to cents (Razorpay expects amount in smallest currency unit)
    // For USD, we use cents, so multiply by 100
    const amountInCents = Math.round(amount * 100);

    // Ensure receipt is max 40 characters (Razorpay requirement)
    const defaultReceipt = `rcpt_${Date.now().toString().slice(-10)}`;
    const finalReceipt = (receipt || defaultReceipt).slice(0, 40);

    const options = {
      amount: amountInCents,
      currency: "USD",
      receipt: finalReceipt,
    };

    const order = await razorpay.orders.create(options);
    return order as RazorpayOrderResponse;
  } catch (error) {
    console.error("Error creating Razorpay order:", error);
    throw new Error("Failed to create payment order");
  }
};

/**
 * Verify Razorpay payment signature
 * @param orderId Razorpay order ID
 * @param paymentId Razorpay payment ID
 * @param signature Razorpay payment signature
 * @returns true if signature is valid, false otherwise
 */
export const verifyPayment = (
  orderId: string,
  paymentId: string,
  signature: string
): boolean => {
  try {
    const text = `${orderId}|${paymentId}`;
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(text)
      .digest("hex");

    return generatedSignature === signature;
  } catch (error) {
    console.error("Error verifying payment signature:", error);
    return false;
  }
};

export default getRazorpayInstance;
