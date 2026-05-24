"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/useLocale";

interface ExpandableDescriptionProps {
  text: string;
}

const COLLAPSED_LINES = 2;

/**
 * YouTube-style description block. Truncates to two lines by default,
 * with a "...more" toggle to expand. Skip the toggle entirely when the
 * content fits in the collapsed budget — no point offering an "expand"
 * affordance on text that's already fully visible.
 *
 * The "does the text actually overflow at 2 lines" check has to run in
 * the browser because we don't know the rendered width at SSR time. The
 * effect measures `scrollHeight > clientHeight` after layout and decides
 * whether to show the toggle. A short delay (`requestAnimationFrame`)
 * ensures fonts have loaded — without it, the measurement happens against
 * the fallback font and overshoots.
 */
export default function ExpandableDescription({ text }: ExpandableDescriptionProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [needsToggle, setNeedsToggle] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!textRef.current) return;
    // Measure after the browser has painted with the right font.
    const raf = requestAnimationFrame(() => {
      const el = textRef.current;
      if (!el) return;
      setNeedsToggle(el.scrollHeight > el.clientHeight + 1); // +1 fudge for sub-pixel rounding
    });
    return () => cancelAnimationFrame(raf);
  }, [text]);

  return (
    <div
      data-testid="expandable-description"
      className="mt-4 rounded-lg p-3"
      style={{ backgroundColor: "var(--theme-bg-secondary)" }}
    >
      <p
        ref={textRef}
        className={`text-sm whitespace-pre-wrap ${expanded ? "" : `line-clamp-${COLLAPSED_LINES}`}`}
        style={{ color: "var(--theme-text)" }}
      >
        {text}
      </p>
      {needsToggle && (
        <button
          onClick={() => setExpanded((p) => !p)}
          data-testid="description-toggle"
          className="mt-2 text-xs font-medium hover:underline"
          style={{ color: "var(--theme-text-secondary)" }}
        >
          {expanded
            ? t("viewer.description.show_less")
            : t("viewer.description.show_more")}
        </button>
      )}
    </div>
  );
}
