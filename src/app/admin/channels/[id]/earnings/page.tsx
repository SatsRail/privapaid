import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ChannelEarningsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const channel = await prisma.channel.findUnique({ where: { id } });
  if (!channel) notFound();

  const sk = await getMerchantKey();
  if (!sk) {
    return (
      <div>
        <h1 className="mb-4 text-2xl font-bold">{channel.name} — Earnings</h1>
        <p className="text-[var(--theme-text-secondary)]">
          Merchant API key not configured. Set it up in{" "}
          <Link
            href="/admin/settings"
            className="text-[var(--theme-primary)] hover:underline"
          >
            settings
          </Link>
          .
        </p>
      </div>
    );
  }

  let payments: { id: string; amount_cents: number; status: string; created_at: string }[] = [];
  let fetchError = "";

  try {
    payments = await satsrail.listPayments(sk);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Failed to fetch payments";
  }

  // Group by month
  const monthlyTotals = new Map<string, number>();
  let totalCents = 0;

  for (const p of payments) {
    if (p.status !== "completed") continue;
    const date = new Date(p.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    monthlyTotals.set(key, (monthlyTotals.get(key) || 0) + p.amount_cents);
    totalCents += p.amount_cents;
  }

  const sortedMonths = Array.from(monthlyTotals.entries()).sort(
    (a, b) => b[0].localeCompare(a[0])
  );

  function formatSats(cents: number) {
    return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0 });
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{channel.name} — Earnings</h1>
          <p className="text-sm text-[var(--theme-text-secondary)]">
            {payments.length} total payment(s)
          </p>
        </div>
        <Link
          href={`/admin/channels/${id}`}
          className="rounded-md border border-[var(--theme-border)] px-4 py-2 text-sm hover:bg-[var(--theme-bg-secondary)]"
        >
          Back to Channel
        </Link>
      </div>

      {fetchError && (
        <p className="mb-4 text-sm text-red-500">{fetchError}</p>
      )}

      <div className="mb-6 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-6">
        <p className="text-sm text-[var(--theme-text-secondary)]">Total Earned</p>
        <p className="text-3xl font-bold">{formatSats(totalCents)} sats</p>
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--theme-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--theme-bg-secondary)]">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">Month</th>
              <th className="px-4 py-3 text-right font-medium text-[var(--theme-text-secondary)]">Earnings (sats)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--theme-border)]">
            {sortedMonths.map(([month, cents]) => (
              <tr key={month} className="hover:bg-[var(--theme-bg-secondary)]">
                <td className="px-4 py-3 font-medium">{month}</td>
                <td className="px-4 py-3 text-right">{formatSats(cents)}</td>
              </tr>
            ))}
            {sortedMonths.length === 0 && !fetchError && (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-[var(--theme-text-secondary)]">
                  No completed payments yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
