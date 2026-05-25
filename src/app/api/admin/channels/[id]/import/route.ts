import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import {
  EntityResults,
  StatusFn,
  MAX_MEDIA_ITEMS,
  errorMsg,
  createApiThrottle,
  createProductSafeType,
  findExistingMedia,
  createNewMedia,
  updateExistingMedia,
} from "@/lib/import-helpers";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;

  const result = await validateBody(req, schemas.channelImportPayload);
  if (isValidationError(result)) return result;

  const { media: importMedia } = result;

  if (importMedia.length > MAX_MEDIA_ITEMS) {
    return NextResponse.json(
      { error: `Too many media items (${importMedia.length}). Maximum is ${MAX_MEDIA_ITEMS} per import.` },
      { status: 422 }
    );
  }

  const { id } = await params;

  const channel = await prisma.channel.findFirst({
    where: { id, deletedAt: null },
  });
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  const channelDoc: { id: string; satsrailProductTypeId: string | null } = {
    id: channel.id,
    satsrailProductTypeId: channel.satsrailProductTypeId,
  };

  const totalSteps = importMedia.length;
  let completedSteps = 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Flush past buffer thresholds for SSE streaming
      controller.enqueue(encoder.encode(`: ${" ".repeat(2048)}\n\n`));

      async function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        await new Promise((r) => setTimeout(r, 10));
      }

      async function sendProgress(
        _phase: string,
        item: string,
        status: "processing" | "done" | "error",
        error?: string
      ) {
        if (status !== "processing") completedSteps++;
        await send("progress", { phase: "media", item, status, error, completed: completedSteps, total: totalSteps });
      }

      async function sendStatus(item: string, detail: string) {
        await send("status", { item, detail });
      }

      try {
        const sk = await getMerchantKey();
        const api = createApiThrottle();

        // Ensure channel has a product type if any media items have products
        const hasProducts = importMedia.some((m) => m.product);
        if (hasProducts && !channelDoc.satsrailProductTypeId && sk) {
          try {
            const productType = await createProductSafeType(
              sk,
              channel.name,
              `ch_${channel.ref || channelDoc.id}`,
              api
            );
            channelDoc.satsrailProductTypeId = productType.id;
            await prisma.channel.update({
              where: { id: channelDoc.id },
              data: { satsrailProductTypeId: productType.id },
            });
          } catch (err) {
            await send("error", { error: `Product type creation failed: ${errorMsg(err)}` });
            controller.close();
            return;
          }
        }

        await send("phase", { phase: "media", total: totalSteps });

        const results: EntityResults = { created: 0, updated: 0, errors: [] };

        for (const mData of importMedia) {
          await sendProgress("media", mData.name, "processing");
          const onStatus: StatusFn = (detail) => sendStatus(mData.name, detail);
          try {
            const existingMedia = await findExistingMedia(mData, channelDoc.id);

            if (existingMedia) {
              await updateExistingMedia(sk, mData, existingMedia, channelDoc, results.errors, api, onStatus);
              results.updated++;
            } else {
              await createNewMedia(sk, mData, channelDoc, results.errors, api, onStatus);
              results.created++;
            }
            await sendProgress("media", mData.name, "done");
          } catch (err) {
            results.errors.push({ entity: "media", name: mData.name, error: errorMsg(err) });
            await sendProgress("media", mData.name, "error", errorMsg(err));
          }
        }

        const hasErrors = results.errors.length > 0;

        audit({
          actorId: auth.id,
          actorEmail: auth.email,
          actorType: "admin",
          action: "channel_import.create",
          targetType: "channel",
          targetId: channelDoc.id,
          details: {
            media: {
              created: results.created,
              updated: results.updated,
              errors: results.errors.length,
            },
          },
        });

        await send("complete", {
          success: !hasErrors,
          results: { media: results },
        });
      } catch (err) {
        await send("error", { error: err instanceof Error ? err.message : "Import failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "none",
    },
  });
}
