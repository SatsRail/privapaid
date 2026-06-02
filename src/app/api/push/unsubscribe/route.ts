import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";

// Public. Endpoint possession is the authorization (bearer model, same shape as
// macaroons) — no identity to check. Deletes this channel's row for the given
// endpoint, or every row for the endpoint when no channel_slug is supplied
// (used when the browser revokes notification permission entirely). Idempotent:
// deleting nothing is still a success.
export async function POST(req: NextRequest) {
  const limited = await rateLimit("push_unsubscribe", 20);
  if (limited) return limited;

  const validated = await validateBody(req, schemas.pushUnsubscribe);
  if (isValidationError(validated)) return validated;

  const { endpoint, channel_slug } = validated;

  await prisma.pushSubscription.deleteMany({
    where: {
      endpoint,
      ...(channel_slug ? { channel: { slug: channel_slug } } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
