import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";
import type { AuditActorType } from "@prisma/client";

interface AuditEntry {
  actorId: string;
  actorEmail?: string;
  actorType: AuditActorType;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/**
 * Write a structured audit log entry. Fire-and-forget — never throws.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const hdrs = await headers();
    const ip =
      hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      hdrs.get("x-real-ip") ||
      "";
    const userAgent = hdrs.get("user-agent") || "";

    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorEmail: entry.actorEmail || "",
        actorType: entry.actorType,
        action: entry.action,
        targetType: entry.targetType || "",
        targetId: entry.targetId || "",
        details: (entry.details ?? {}) as object,
        ip,
        userAgent,
      },
    });
  } catch (err) {
    console.error("Audit log write failed:", err);
  }
}
