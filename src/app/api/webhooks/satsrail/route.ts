import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { connectDB } from "@/lib/mongodb";
import WebhookEvent from "@/models/WebhookEvent";
import * as Sentry from "@sentry/nextjs";

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

function verifyWebhookSignature(payload: string, signature: string): boolean {
  const secret = process.env.SATSRAIL_WEBHOOK_SECRET;
  if (!secret) {
    console.error("SATSRAIL_WEBHOOK_SECRET not configured");
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-satsrail-signature") || "";
  const timestamp = req.headers.get("x-satsrail-timestamp") || "";

  // Verify signature
  if (!verifyWebhookSignature(body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Validate timestamp to prevent replay attacks
  if (timestamp) {
    const eventTime = parseInt(timestamp, 10) * 1000; // assume unix seconds
    const now = Date.now();
    if (isNaN(eventTime) || Math.abs(now - eventTime) > TIMESTAMP_TOLERANCE_MS) {
      return NextResponse.json({ error: "Timestamp out of tolerance" }, { status: 400 });
    }
  }

  let event: { id?: string; type: string; payload: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  await connectDB();

  // Idempotency claim — atomically insert the event_id so two concurrent
  // deliveries can't both proceed past this point. The unique index on
  // event_id (WebhookEvent.ts) provides the underlying guarantee; the
  // upsert here is the application-level read/write that consumes it
  // without a TOCTOU window. The PRE-image (`new: false`) tells us whether
  // we won the race: null = we just inserted, non-null = a prior request
  // already claimed it and we should bail out.
  if (event.id && typeof event.id === "string") {
    let prior: { _id: unknown } | null = null;
    try {
      prior = await WebhookEvent.findOneAndUpdate(
        { event_id: String(event.id) },
        {
          $setOnInsert: {
            event_id: String(event.id),
            event_type: event.type,
          },
        },
        { upsert: true, returnDocument: "before", lean: true }
      );
    } catch (err) {
      // E11000 races at the unique index level also mean "already claimed."
      // findOneAndUpdate with upsert: true should not normally throw this,
      // but driver versions differ — treat it the same as a duplicate.
      const code = (err as { code?: number } | null)?.code;
      if (code === 11000) {
        return NextResponse.json({ received: true, duplicate: true });
      }
      throw err;
    }
    if (prior) {
      return NextResponse.json({ received: true, duplicate: true });
    }
  }

  try {
    switch (event.type) {
      case "product.key_rotated": {
        // Re-encryption is now admin-triggered via /api/admin/products/[id]/re-encrypt.
        // Webhooks are unreliable and may never arrive, so the entire rotation
        // lifecycle is pull-based through the admin UI.
        console.log("Key rotation detected (audit only):", event.payload);
        break;
      }

      case "merchant.plan_changed": {
        console.log("Plan changed:", event.payload);
        break;
      }

      case "merchant.suspended": {
        const { merchant_id } = event.payload;
        console.log("Merchant suspended:", merchant_id);
        break;
      }

      default:
        console.log("Unknown webhook event:", event.type);
    }

    // The idempotency record was inserted atomically above. No second
    // write needed here.

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    Sentry.captureException(err, { tags: { context: "webhook_endpoint" } });
    return NextResponse.json(
      { error: "Internal processing error" },
      { status: 500 }
    );
  }
}
