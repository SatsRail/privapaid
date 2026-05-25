import { prisma } from "@/lib/prisma";
import config from "@/config/instance";
import ChannelForm from "../ChannelForm";

export const dynamic = "force-dynamic";

export default async function NewChannelPage() {
  const categories = await prisma.category.findMany({
    where: { active: true },
    orderBy: { position: "asc" },
    select: { id: true, name: true },
  });

  const cats = categories.map((c) => ({
    _id: c.id,
    name: c.name,
  }));

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">New Channel</h1>
      <ChannelForm categories={cats} nsfwEnabled={config.nsfw} />
    </div>
  );
}
