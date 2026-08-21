import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getInstanceConfig } from "@/config/instance";

export const dynamic = "force-dynamic";

export async function GET() {
  const result: Record<string, string> = { status: "ok" };

  // Postgres is the app's own dependency — losing it means this instance
  // cannot serve, so it drives the overall status and the HTTP code.
  try {
    await prisma.$queryRaw`SELECT 1`;
    result.db = "connected";
  } catch {
    result.status = "degraded";
    result.db = "disconnected";
  }

  // SatsRail reachability is reported, never fatal. Two reasons:
  //
  //  1. Probe the URL the app actually calls rather than only an explicit env
  //     override. A deployment on the built-in default still depends on the
  //     portal, and answering "not_configured" there hid precisely the
  //     connectivity failure this check exists to surface.
  //  2. This endpoint is the container healthcheck (see railway.toml, which
  //     restarts ON_FAILURE). Failing it because a third party is down would
  //     turn a portal blip into a restart loop, so SatsRail status is
  //     informational and does not move `status` or the HTTP code.
  const { satsrail } = await getInstanceConfig();
  const satsrailUrl = satsrail.apiUrl;
  result.satsrail_url = satsrailUrl;

  try {
    const res = await fetch(`${satsrailUrl}/pub/exchanges`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    result.satsrail = res.ok ? "reachable" : `http_${res.status}`;
  } catch {
    result.satsrail = "unreachable";
  }

  const statusCode = result.status === "ok" ? 200 : 503;
  return NextResponse.json(result, { status: statusCode });
}
