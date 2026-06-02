import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";
import { getInstanceConfig } from "@/config/instance";

// Public (not /api/admin) — anonymous viewers opt into push without an account.
// Stores the browser's opaque push endpoint scoped to one channel. Idempotent:
// the same browser re-subscribing to the same channel refreshes the row.
export async function POST(req: NextRequest) {
  const limited = await rateLimit("push_subscribe", 20);
  if (limited) return limited;

  const validated = await validateBody(req, schemas.pushSubscribe);
  if (isValidationError(validated)) return validated;

  const { channel_slug, subscription } = validated;

  // Same channel guard the RSS feed uses: active, not soft-deleted, and hidden
  // when the instance disallows NSFW.
  const channel = await prisma.channel.findFirst({
    where: { slug: channel_slug, active: true, deletedAt: null },
    select: { id: true, nsfw: true },
  });
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }
  const { nsfw: nsfwAllowed } = await getInstanceConfig();
  if (!nsfwAllowed && channel.nsfw) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  await prisma.pushSubscription.upsert({
    where: {
      channelId_endpoint: {
        channelId: channel.id,
        endpoint: subscription.endpoint,
      },
    },
    create: {
      channelId: channel.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    update: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      lastSeenAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
