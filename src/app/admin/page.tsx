import { prisma } from "@/lib/prisma";
import { t } from "@/i18n";
import { getInstanceConfig } from "@/config/instance";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const { locale } = await getInstanceConfig();

  const [channelCount, mediaCount, categoryCount] =
    await Promise.all([
      prisma.channel.count({ where: { active: true } }),
      prisma.media.count(),
      prisma.category.count({ where: { active: true } }),
    ]);

  const stats = [
    { label: t(locale, "admin.dashboard.channels"), value: channelCount, href: "/admin/channels" },
    { label: t(locale, "admin.dashboard.media_items"), value: mediaCount, href: "/admin/channels" },
    { label: t(locale, "admin.dashboard.categories"), value: categoryCount, href: "/admin/categories" },
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t(locale, "admin.dashboard.title")}</h1>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-5"
          >
            <p className="text-sm text-[var(--theme-text-secondary)]">{stat.label}</p>
            <p className="mt-1 text-3xl font-bold">{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
