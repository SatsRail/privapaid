import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCustomerApi } from "@/lib/auth-helpers";

export async function GET() {
  const customer = await requireCustomerApi();
  if (customer instanceof NextResponse) return customer;

  const comments = await prisma.comment.findMany({
    where: { customerId: customer.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      media: {
        select: {
          id: true,
          name: true,
          deletedAt: true,
          channel: { select: { id: true, name: true, slug: true } },
        },
      },
    },
  });

  const data = comments.map((c) => ({
    _id: c.id,
    body: c.body,
    nickname: c.nickname,
    created_at: c.createdAt,
    media:
      c.media && !c.media.deletedAt
        ? {
            _id: c.media.id,
            name: c.media.name,
            channel_slug: c.media.channel?.slug ?? null,
            channel_name: c.media.channel?.name ?? null,
          }
        : null,
  }));

  return NextResponse.json({ data });
}
