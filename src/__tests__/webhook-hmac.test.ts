import crypto from "crypto";
import express from "express";
import request from "supertest";
import { verifyWebhookSignature } from "../services/razorpayService";

const TEST_SECRET = "test_secret";

process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRET;

function makeHmac(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function buildApp() {
  const app = express();
  app.use(
    express.json({
      verify: (_req, _res, buf) => {
        const req = _req as any;
        if (typeof req.url === "string" && req.url.includes("/wallet/webhook")) {
          req.rawBody = buf;
        }
      },
    })
  );
  app.post("/wallet/webhook", (req: any, res) => {
    res.json({ rawBodySet: !!req.rawBody });
  });
  app.get("/api/users/me", (req: any, res) => {
    res.json({ rawBodySet: !!req.rawBody });
  });
  return app;
}

describe("verifyWebhookSignature — unit", () => {
  const payload = JSON.stringify({ event: "payment.captured", payload: {} });

  it("returns true for a valid HMAC signature", () => {
    const sig = makeHmac(payload, TEST_SECRET);
    expect(verifyWebhookSignature(payload, sig)).toBe(true);
  });

  it("returns false when body is tampered", () => {
    const sig = makeHmac(payload, TEST_SECRET);
    const tampered = payload.replace("captured", "TAMPERED");
    expect(verifyWebhookSignature(tampered, sig)).toBe(false);
  });

  it("returns false for a mismatched signature", () => {
    const sig = makeHmac(payload, "wrong_secret");
    expect(verifyWebhookSignature(payload, sig)).toBe(false);
  });

  it("accepts a Buffer as body and matches the same string", () => {
    const buf = Buffer.from(payload, "utf8");
    const sig = makeHmac(payload, TEST_SECRET);
    expect(verifyWebhookSignature(buf, sig)).toBe(true);
  });

  it("Buffer with tampered bytes returns false", () => {
    const buf = Buffer.from(payload.replace("captured", "TAMPERED"), "utf8");
    const sig = makeHmac(payload, TEST_SECRET);
    expect(verifyWebhookSignature(buf, sig)).toBe(false);
  });
});

describe("raw-body capture — middleware integration", () => {
  const app = buildApp();

  it("sets rawBody on /wallet/webhook requests", async () => {
    const payload = JSON.stringify({ event: "payment.captured" });
    const res = await request(app)
      .post("/wallet/webhook")
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.rawBodySet).toBe(true);
  });

  it("does NOT set rawBody on non-webhook paths", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.rawBodySet).toBe(false);
  });
});
