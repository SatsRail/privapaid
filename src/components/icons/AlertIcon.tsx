/**
 * Amber alert icon used by the post-payment failure cards. Two variants:
 *
 *   triangle — the customer's payment went through but content didn't unlock
 *              (hard failure, user needs the merchant's help to recover).
 *   info     — verification hit a transient issue; the customer's access is
 *              probably still valid (soft failure, reload usually fixes it).
 *
 * Kept as a single component because the variants share the amber circle
 * chrome that signals "something went wrong, payment is still safe."
 */
interface AlertIconProps {
  variant: "triangle" | "info";
}

export default function AlertIcon({ variant }: AlertIconProps) {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {variant === "triangle" ? (
          <>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </>
        )}
      </svg>
    </div>
  );
}
