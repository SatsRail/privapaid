"use client";

// Status badges use a translucent tint of a semantic hue + a mid-tone text
// color so they read on ANY theme surface — the light admin and the dark
// viewer alike. The previous `dark:` variants were a trap: `<html>` carries a
// permanent `.dark` class app-wide (layout.tsx), so the dark variants fired
// even inside the light admin, rendering dark chips on white. Tints driven by
// alpha need no surface assumption. The neutral/default routes through theme
// tokens so it always matches whatever surface it sits on.
const colorMap = {
  green: "bg-green-500/15 text-green-600",
  red: "bg-red-500/15 text-red-600",
  yellow: "bg-yellow-500/20 text-yellow-700",
  blue: "bg-blue-500/15 text-blue-600",
  pink: "bg-pink-500/15 text-pink-600",
  zinc: "bg-[var(--theme-bg-secondary)] text-[var(--theme-text-secondary)]",
};

interface BadgeProps {
  children: React.ReactNode;
  color?: keyof typeof colorMap;
  className?: string;
}

export default function Badge({
  children,
  color = "zinc",
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colorMap[color]} ${className}`}
    >
      {children}
    </span>
  );
}
