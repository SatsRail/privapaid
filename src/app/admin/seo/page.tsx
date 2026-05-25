import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth-helpers";
import SeoForm from "./SeoForm";

export const dynamic = "force-dynamic";

export default async function SeoPage() {
  await requireOwner();

  const settings = await prisma.settings.findFirst({
    where: { setupCompleted: true },
    select: { googleAnalyticsId: true, googleSiteVerification: true },
  });

  if (!settings) {
    return (
      <div className="py-16 text-center text-[var(--theme-text-secondary)]">
        <p>Settings not found. Complete setup first.</p>
      </div>
    );
  }

  const initialValues = {
    google_analytics_id: settings.googleAnalyticsId || "",
    google_site_verification: settings.googleSiteVerification || "",
  };

  return (
    <div>
      <SeoForm initialValues={initialValues} />
    </div>
  );
}
