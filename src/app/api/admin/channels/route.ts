import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getNextRef } from "@/models/Counter";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import type { Prisma } from "@prisma/client";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "20");
  const categoryId = searchParams.get("category_id");

  const where: Prisma.ChannelWhereInput = { deletedAt: null };
  if (categoryId) where.categoryId = categoryId;

  const [channels, total] = await Promise.all([
    prisma.channel.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: { category: { select: { name: true } } },
    }),
    prisma.channel.count({ where }),
  ]);

  return NextResponse.json({
    data: channels,
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  });
}

export async function POST(req: NextRequest) {
  const result = await validateBody(req, schemas.channelCreate);
  if (isValidationError(result)) return result;

  const { name } = result;
  const slug = result.slug || slugify(name);
  const existing = await prisma.channel.findUnique({ where: { slug } });
  if (existing) {
    return NextResponse.json(
      { error: "Slug already taken" },
      { status: 422 }
    );
  }

  const ref = await getNextRef("channel");

  // Create a product type on SatsRail for this channel
  let satsrailProductTypeId: string | null = null;
  const sk = await getMerchantKey();
  if (sk) {
    try {
      const productType = await satsrail.createProductType(sk, {
        name,
        external_ref: `ch_${ref}`,
      });
      satsrailProductTypeId = productType.id;
    } catch (err) {
      console.error("Failed to create SatsRail product type:", err);
    }
  }

  const channel = await prisma.channel.create({
    data: {
      ref,
      name,
      slug,
      satsrailProductTypeId,
      bio: result.bio || "",
      categoryId: result.category_id || undefined,
      nsfw: result.nsfw || false,
      profileImageUrl: result.profile_image_url || "",
      socialLinks: (result.social_links || {}) as Prisma.InputJsonValue,
      active: true,
      mediaCount: 0,
    },
  });

  return NextResponse.json({ data: channel }, { status: 201 });
}
