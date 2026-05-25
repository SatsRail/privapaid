import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { t } from "@/i18n";
import { getInstanceConfig } from "@/config/instance";
import AdultContentSettings from "./AdultContentSettings";
import CategoryList from "./CategoryList";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const categories = await prisma.category.findMany({
    orderBy: { position: "asc" },
  });
  const settings = await prisma.settings.findFirst({
    where: { setupCompleted: true },
    select: { nsfwEnabled: true, adultDisclaimer: true },
  });
  const { locale } = await getInstanceConfig();

  const serializedCategories = categories.map((cat) => ({
    _id: cat.id,
    name: cat.name,
    slug: cat.slug,
    position: cat.position,
    active: cat.active,
  }));

  return (
    <div>
      <AdultContentSettings
        initialNsfw={settings?.nsfwEnabled ?? false}
        initialDisclaimer={settings?.adultDisclaimer ?? ""}
      />

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t(locale, "admin.categories.title")}</h1>
        <Link
          href="/admin/categories/new"
          className="rounded-md bg-[var(--theme-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          {t(locale, "admin.categories.new")}
        </Link>
      </div>

      <CategoryList initialCategories={serializedCategories} />
    </div>
  );
}
