import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getNextRef } from "@/models/Counter";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import {
  EntityResults,
  ImportChannel,
  SendProgressFn,
  StatusFn,
  MAX_MEDIA_ITEMS,
  errorMsg,
  slugify,
  ApiThrottle,
  createApiThrottle,
  ensureChannelProductType,
  tryCreateProductType,
  findExistingMedia,
  createNewMedia,
  updateExistingMedia,
  createEncryptedChannelProduct,
} from "@/lib/import-helpers";
import type { Prisma } from "@prisma/client";

type ImportCategory = { slug: string; name: string; position?: number; active?: boolean };

// --- Phase 1: Upsert categories ---
async function importCategoriesPhase(
  importCategories: ImportCategory[],
  sendProgress: SendProgressFn
): Promise<{ results: EntityResults; slugToId: Map<string, string> }> {
  const results: EntityResults = { created: 0, updated: 0, errors: [] };
  const slugToId = new Map<string, string>();

  const existingCategories = await prisma.category.findMany();
  for (const cat of existingCategories) {
    slugToId.set(cat.slug, cat.id);
  }

  for (const catData of importCategories) {
    await sendProgress("categories", catData.name, "processing");
    try {
      const catSlug = catData.slug || slugify(catData.name);
      const existing = await prisma.category.findUnique({ where: { slug: catSlug } });

      if (existing) {
        await prisma.category.update({
          where: { id: existing.id },
          data: {
            name: catData.name,
            ...(catData.position !== undefined ? { position: catData.position } : {}),
            active: catData.active ?? true,
          },
        });
        slugToId.set(catSlug, existing.id);
        results.updated++;
      } else {
        const maxPos = await prisma.category.findFirst({
          orderBy: { position: "desc" },
          select: { position: true },
        });

        const category = await prisma.category.create({
          data: {
            name: catData.name,
            slug: catSlug,
            position: catData.position ?? (maxPos?.position ?? 0) + 1,
            active: catData.active ?? true,
          },
        });
        slugToId.set(catSlug, category.id);
        results.created++;
      }
      await sendProgress("categories", catData.name, "done");
    } catch (err) {
      results.errors.push({ entity: "category", name: catData.name, error: errorMsg(err) });
      await sendProgress("categories", catData.name, "error", errorMsg(err));
    }
  }

  return { results, slugToId };
}

// --- Phase 2: Upsert channels ---
async function importChannelsPhase(
  importChannels: ImportChannel[],
  categorySlugToId: Map<string, string>,
  sk: string | null,
  api: ApiThrottle,
  sendProgress: SendProgressFn,
  sendStatus: (item: string, detail: string) => Promise<void>
): Promise<{ results: EntityResults; slugToDoc: Map<string, { _id: string; satsrail_product_type_id: string | null }> }> {
  const results: EntityResults = { created: 0, updated: 0, errors: [] };
  const slugToDoc = new Map<string, { _id: string; satsrail_product_type_id: string | null }>();

  const existingChannels = await prisma.channel.findMany({
    where: { deletedAt: null },
  });
  for (const ch of existingChannels) {
    slugToDoc.set(ch.slug, { id: ch.id, satsrailProductTypeId: ch.satsrailProductTypeId });
  }

  for (const chData of importChannels) {
    await sendProgress("channels", chData.name, "processing");
    const onStatus: StatusFn = (detail) => sendStatus(chData.name, detail);
    try {
      const chSlug = chData.slug || slugify(chData.name);
      const categoryId = chData.category_slug ? categorySlugToId.get(chData.category_slug) || null : null;
      const existing = slugToDoc.get(chSlug);

      if (existing) {
        if (sk) await ensureChannelProductType(sk, existing, chData, results.errors, api, onStatus);

        await onStatus("Updating channel record...");
        await prisma.channel.update({
          where: { id: existing._id },
          data: {
            name: chData.name,
            bio: chData.bio || "",
            category: categoryId ? { connect: { id: categoryId } } : { disconnect: true },
            nsfw: chData.nsfw ?? false,
            socialLinks: (chData.social_links || {}) as Prisma.InputJsonValue,
            profileImageUrl: chData.profile_image_url || "",
            active: chData.active ?? true,
          },
        });
        results.updated++;
      } else {
        const ref = await getNextRef("channel");
        await onStatus("Creating channel record...");
        const satsrailProductTypeId = sk ? await tryCreateProductType(sk, chData.name, `ch_${ref}`, results.errors, api, onStatus) : null;

        const channel = await prisma.channel.create({
          data: {
            ref,
            name: chData.name,
            slug: chSlug,
            satsrailProductTypeId,
            bio: chData.bio || "",
            categoryId: categoryId || undefined,
            nsfw: chData.nsfw ?? false,
            profileImageUrl: chData.profile_image_url || "",
            socialLinks: (chData.social_links || {}) as Prisma.InputJsonValue,
            active: chData.active ?? true,
            mediaCount: 0,
          },
        });

        slugToDoc.set(chSlug, { id: channel.id, satsrailProductTypeId: satsrailProductTypeId });
        results.created++;
      }
      await sendProgress("channels", chData.name, "done");
    } catch (err) {
      results.errors.push({ entity: "channel", name: chData.name, error: errorMsg(err) });
      await sendProgress("channels", chData.name, "error", errorMsg(err));
    }
  }

  return { results, slugToDoc };
}

// --- Phase 3: Upsert media ---
async function importMediaPhase(
  importChannels: ImportChannel[],
  channelSlugToDoc: Map<string, { id: string; satsrailProductTypeId: string | null }>,
  sk: string | null,
  api: ApiThrottle,
  sendProgress: SendProgressFn,
  sendStatus: (item: string, detail: string) => Promise<void>
): Promise<EntityResults> {
  const results: EntityResults = { created: 0, updated: 0, errors: [] };

  for (const chData of importChannels) {
    const chSlug = chData.slug || slugify(chData.name);
    const channelDoc = channelSlugToDoc.get(chSlug);
    if (!channelDoc) continue;

    const mediaItems = chData.media || [];
    for (const mData of mediaItems) {
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
  }

  return results;
}

// --- Phase 4: Create channel access products ---
async function importChannelProductsPhase(
  importChannels: ImportChannel[],
  channelSlugToDoc: Map<string, { id: string; satsrailProductTypeId: string | null }>,
  sk: string,
  api: ApiThrottle,
  sendProgress: SendProgressFn,
  sendStatus: (item: string, detail: string) => Promise<void>
): Promise<EntityResults> {
  const results: EntityResults = { created: 0, updated: 0, errors: [] };

  for (const chData of importChannels) {
    if (!chData.product) continue;

    const chSlug = chData.slug || slugify(chData.name);
    const channelDoc = channelSlugToDoc.get(chSlug);
    if (!channelDoc || !channelDoc.satsrailProductTypeId) continue;

    await sendProgress("channel_products", chData.name, "processing");
    const onStatus: StatusFn = (detail) => sendStatus(chData.name, detail);
    try {
      const channel = await prisma.channel.findUnique({
        where: { id: channelDoc.id },
        select: { ref: true },
      });
      if (!channel || channel.ref == null) {
        results.errors.push({ entity: "channel_product", name: chData.name, error: "Channel has no ref assigned" });
        await sendProgress("channel_products", chData.name, "error", "Channel has no ref assigned");
        continue;
      }

      await createEncryptedChannelProduct(
        sk,
        {
          name: chData.product.name,
          price_cents: chData.product.price_cents,
          currency: chData.product.currency,
          access_duration_seconds: chData.product.access_duration_seconds,
          product_type_id: channelDoc.satsrailProductTypeId,
          external_ref: chData.product.external_ref || `ch_${channel.ref}`,
        },
        channelDoc.id,
        api,
        onStatus
      );

      results.created++;
      await sendProgress("channel_products", chData.name, "done");
    } catch (err) {
      results.errors.push({ entity: "channel_product", name: chData.name, error: errorMsg(err) });
      await sendProgress("channel_products", chData.name, "error", errorMsg(err));
    }
  }

  return results;
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;

  const result = await validateBody(req, schemas.importPayload);
  if (isValidationError(result)) return result;

  const { categories: importCategories, channels: importChannels } = result;

  const totalMedia = importChannels.reduce(
    (sum: number, ch: { media?: unknown[] }) => sum + (ch.media?.length || 0),
    0
  );
  if (totalMedia > MAX_MEDIA_ITEMS) {
    return NextResponse.json(
      { error: `Too many media items (${totalMedia}). Maximum is ${MAX_MEDIA_ITEMS} per import.` },
      { status: 422 }
    );
  }

  const channelsWithProduct = importChannels.filter((ch: { product?: unknown }) => ch.product).length;
  const totalSteps = importCategories.length + importChannels.length + totalMedia + channelsWithProduct;
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

      async function sendProgress(phase: string, item: string, status: "processing" | "done" | "error", error?: string) {
        if (status !== "processing") completedSteps++;
        await send("progress", { phase, item, status, error, completed: completedSteps, total: totalSteps });
      }

      async function sendStatus(item: string, detail: string) {
        await send("status", { item, detail });
      }

      try {
        // Phase 1: Categories
        await send("phase", { phase: "categories", total: importCategories.length });
        const { results: categoryResults, slugToId: categorySlugToId } =
          await importCategoriesPhase(importCategories, sendProgress);

        // Phase 2: Channels
        await send("phase", { phase: "channels", total: importChannels.length });
        const sk = await getMerchantKey();
        const api = createApiThrottle();
        const { results: channelResults, slugToDoc: channelSlugToDoc } =
          await importChannelsPhase(importChannels, categorySlugToId, sk, api, sendProgress, sendStatus);

        // Phase 3: Media
        await send("phase", { phase: "media", total: totalMedia });
        const mediaResults = await importMediaPhase(importChannels, channelSlugToDoc, sk, api, sendProgress, sendStatus);

        // Phase 4: Channel access products (must run after media so all URLs exist)
        let channelProductResults: EntityResults = { created: 0, updated: 0, errors: [] };
        if (channelsWithProduct > 0 && sk) {
          await send("phase", { phase: "channel_products", total: channelsWithProduct });
          channelProductResults = await importChannelProductsPhase(importChannels, channelSlugToDoc, sk, api, sendProgress, sendStatus);
        }

        const hasErrors =
          categoryResults.errors.length > 0 ||
          channelResults.errors.length > 0 ||
          mediaResults.errors.length > 0 ||
          channelProductResults.errors.length > 0;

        audit({
          actorId: auth.id, actorEmail: auth.email, actorType: "admin",
          action: "import.create", targetType: "content",
          details: {
            categories: { created: categoryResults.created, updated: categoryResults.updated, errors: categoryResults.errors.length },
            channels: { created: channelResults.created, updated: channelResults.updated, errors: channelResults.errors.length },
            media: { created: mediaResults.created, updated: mediaResults.updated, errors: mediaResults.errors.length },
            channel_products: { created: channelProductResults.created, updated: channelProductResults.updated, errors: channelProductResults.errors.length },
          },
        });

        await send("complete", {
          success: !hasErrors,
          results: { categories: categoryResults, channels: channelResults, media: mediaResults, channel_products: channelProductResults },
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
