import { prisma } from "@/lib/prisma";
import { requireCustomer } from "@/lib/auth-helpers";
import { getInstanceConfig } from "@/config/instance";
import { t } from "@/i18n";
import ViewerShell from "@/components/ViewerShell";
import ProfileComments from "./ProfileComments";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await requireCustomer();
  const { locale } = await getInstanceConfig();

  const customer = await prisma.customer.findUnique({
    where: { id: session.id },
    include: {
      comments: {
        include: {
          media: {
            include: { channel: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      },
    },
  });

  if (!customer) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <p style={{ color: "var(--theme-text-secondary)" }}>
          Customer not found.
        </p>
      </div>
    );
  }

  const serializedComments = customer.comments.map((c) => {
    const media = c.media;
    const channel = media?.channel;

    return {
      _id: c.id,
      body: c.body,
      nickname: c.nickname,
      created_at: c.createdAt.toISOString(),
      media: media
        ? {
            _id: media.id,
            name: media.name,
            channel_slug: channel?.slug || null,
            channel_name: channel?.name || null,
          }
        : null,
    };
  });

  return (
    <ViewerShell>
      <div className="mx-auto max-w-2xl px-4 py-8">
        {/* Profile header */}
        <div className="mb-8 flex items-center gap-4">
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-xl font-bold"
            style={{ backgroundColor: "var(--theme-primary)", color: "#000" }}
          >
            {customer.nickname.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1
              className="text-2xl font-bold"
              style={{ color: "var(--theme-heading)" }}
            >
              {customer.nickname}
            </h1>
            <p
              className="text-sm"
              style={{ color: "var(--theme-text-secondary)" }}
            >
              {t(locale, "viewer.profile.member_since")}{" "}
              {customer.createdAt.toLocaleDateString()}
            </p>
          </div>
        </div>

        {/* Comments section */}
        <h2
          className="mb-4 text-lg font-semibold"
          style={{ color: "var(--theme-heading)" }}
        >
          {t(locale, "viewer.profile.comments")} ({serializedComments.length})
        </h2>

        <ProfileComments
          comments={serializedComments}
          emptyMessage={t(locale, "viewer.profile.no_comments")}
        />
      </div>
    </ViewerShell>
  );
}
