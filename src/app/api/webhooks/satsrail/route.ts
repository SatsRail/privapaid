import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
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

  // Idempotency claim — atomically insert the event_id so two concurrent
  // deliveries can't both proceed past this point. The unique index on
  // WebhookEvent.eventId is the underlying guarantee; a Prisma create
  // that races a sibling delivery surfaces a P2002 unique-constraint
  // error, which we treat as "already claimed" and short-circuit.
  if (event.id && typeof event.id === "string") {
    try {
      await prisma.webhookEvent.create({
        data: {
          eventId: String(event.id),
          eventType: event.type,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return NextResponse.json({ received: true, duplicate: true });
      }
      throw err;
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
