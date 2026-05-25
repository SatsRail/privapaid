import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const result: Record<string, string> = { status: "ok" };

  // Check Postgres
  try {
    await prisma.$queryRaw`SELECT 1`;
    result.db = "connected";
  } catch {
    result.status = "degraded";
    result.db = "disconnected";
  }

  // Check SatsRail API reachability
  const satsrailUrl = process.env.SATSRAIL_API_URL;
  if (satsrailUrl) {
    try {
      const res = await fetch(`${satsrailUrl}/pub/exchanges`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      result.satsrail = res.ok ? "reachable" : `http_${res.status}`;
    } catch {
      result.status = "degraded";
      result.satsrail = "unreachable";
    }
  } else {
    result.satsrail = "not_configured";
  }

  const statusCode = result.status === "ok" ? 200 : 503;
  return NextResponse.json(result, { status: statusCode });
}
