/**
 * Reusable shimmer/skeleton primitive. Tailwind's `animate-pulse` is
 * exactly what YouTube uses for loading placeholders — a soft opacity
 * fade in/out at ~2s cadence. The background color uses our theme
 * variable so dark/light themes both look right.
 */
export default function Skeleton({
  className = "",
  testId,
}: {
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={`animate-pulse rounded ${className}`}
      style={{ backgroundColor: "var(--theme-bg-secondary)" }}
      data-testid={testId}
      aria-hidden="true"
    />
  );
}
