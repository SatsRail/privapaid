// Shared button styling. Deliberately NOT a "use client" module: it exports a
// pure class-builder so SERVER components (e.g. <Link> CTAs in admin pages) can
// compose the exact same look as a <Button> without pulling a client component
// across the server boundary. (A function imported from a "use client" module
// becomes a client-reference proxy and cannot be called during server render.)

export const buttonVariants = {
  primary:
    "bg-[var(--theme-primary)] text-white hover:opacity-90 disabled:opacity-50",
  secondary:
    "bg-[var(--theme-bg-secondary)] text-[var(--theme-text)] hover:opacity-80",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:opacity-50",
  ghost:
    "bg-transparent text-[var(--theme-text-secondary)] hover:bg-[var(--theme-bg-secondary)]",
  // Bordered secondary action (Cancel / Back). Normalizes the hand-rolled
  // bordered buttons that previously used either an invisible white-on-white
  // hover (hover:bg-[var(--theme-bg)]) or hover:opacity-80 — both now resolve
  // to a visible surface tint.
  outline:
    "border border-[var(--theme-border)] bg-transparent text-[var(--theme-text)] hover:bg-[var(--theme-bg-secondary)] disabled:opacity-50",
} as const;

export const buttonSizes = {
  xs: "px-3 py-1 text-xs",
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-base",
} as const;

export type ButtonVariant = keyof typeof buttonVariants;
export type ButtonSize = keyof typeof buttonSizes;

// `focus-visible` (not `focus`) so the ring shows on keyboard nav only;
// `focus-visible:outline-none` overrides the global :focus-visible outline
// (globals.css) so we get one clean ring instead of a doubled outline + ring.
const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--theme-primary)] disabled:cursor-not-allowed";

export function buttonClasses({
  variant = "primary",
  size = "md",
  className = "",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return `${base} ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`.trim();
}
