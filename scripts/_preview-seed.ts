// TEMP verification seed — delete after use. Creates a renderable show page
// (channel + main media + siblings) so the /c/[slug]/[mediaId] layout can be
// inspected in the browser. No products → player shows UnavailableWall, but
// the full info block + right rail render.
import "dotenv/config"; // load .env (DATABASE_URL, CONTENT_KEK) for standalone runs
import { PrismaClient } from "@prisma/client";
import { createEnvelopeArtifacts, URL_ENVELOPE_MIME } from "@/lib/media-envelope";

const prisma = new PrismaClient();

// Every media has exactly one MediaEnvelope holding its encrypted payload (the
// source URL for url media). Needs CONTENT_KEK in the env to wrap the DEK.
async function seedEnvelope(mediaId: string, url: string): Promise<void> {
  const art = createEnvelopeArtifacts(Buffer.from(url, "utf8"));
  await prisma.mediaEnvelope.create({
    data: {
      mediaId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bytes: art.bytes as any,
      mimeType: URL_ENVELOPE_MIME,
      wrappedDek: art.wrappedDek,
    },
  });
}

function tile(color: string, label: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'>` +
    `<rect width='100%' height='100%' fill='${color}'/>` +
    `<text x='50%' y='52%' font-family='sans-serif' font-size='120' fill='white' ` +
    `text-anchor='middle' dominant-baseline='middle'>${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function main() {
  // Storefront is gated behind a completed setup (Settings.setupCompleted).
  // Seed a minimal singleton row so /c pages render instead of /setup.
  await prisma.settings.upsert({
    where: { id: 1 },
    update: { setupCompleted: true },
    create: { id: 1, setupCompleted: true, instanceName: "Demo Studio" },
  });

  const slug = "demo-studio";
  await prisma.media.deleteMany({ where: { channel: { slug } } });
  await prisma.channel.deleteMany({ where: { slug } });

  const channel = await prisma.channel.create({
    data: {
      slug,
      name: "Demo Studio",
      bio: "Hands-on builds and teardowns.",
      active: true,
      nsfw: false,
      profileImageUrl: tile("#7c3aed", "D"),
    },
  });

  const main = await prisma.media.create({
    data: {
      channelId: channel.id,
      name: "Behind the Build: Encrypted Streaming, End to End",
      description:
        "A full walkthrough of how paid content stays encrypted from upload to playback. " +
        "We cover envelope encryption, per-product keys, and how the paywall hands back a " +
        "decryption key only after payment clears. Long enough to trip the two-line clamp so " +
        "the show-more toggle appears.",
      mediaType: "video",
      viewsCount: 12480,
      likesCount: 342,
      sharesCount: 58,
      position: 1,
    },
  });
  await seedEnvelope(main.id, "https://example.com/video.mp4");
  await prisma.mediaImage.create({
    data: { mediaId: main.id, kind: "thumbnail", externalUrl: tile("#1e293b", "▶"), position: 0 },
  });
  await prisma.mediaImage.createMany({
    data: [tile("#3b82f6", "1"), tile("#10b981", "2"), tile("#f59e0b", "3")].map(
      (url, i) => ({ mediaId: main.id, kind: "preview" as const, externalUrl: url, position: i })
    ),
  });

  const siblings = [
    { name: "Key Rotation Without Downtime", views: 8800, color: "#ef4444" },
    { name: "Designing the Paywall UX", views: 6400, color: "#06b6d4" },
    { name: "Why We Don't Touch Payments", views: 4100, color: "#a855f7" },
    { name: "Importing a Back Catalog", views: 2300, color: "#84cc16" },
  ];
  let pos = 2;
  for (const s of siblings) {
    const sib = await prisma.media.create({
      data: {
        channelId: channel.id,
        name: s.name,
        mediaType: "video",
        viewsCount: s.views,
        position: pos++,
      },
    });
    await seedEnvelope(sib.id, "https://example.com/video.mp4");
    await prisma.mediaImage.create({
      data: { mediaId: sib.id, kind: "thumbnail", externalUrl: tile(s.color, "▶"), position: 0 },
    });
  }
  await prisma.channel.update({
    where: { id: channel.id },
    data: { mediaCount: 1 + siblings.length },
  });

  console.log(`SHOW_URL=/c/${slug}/${main.id}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
