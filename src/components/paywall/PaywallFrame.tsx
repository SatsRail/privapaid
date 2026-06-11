"use client";

import type { ReactNode } from "react";

interface PaywallFrameProps {
  mediaType: string;
  thumbnailUrl?: string;
  children: ReactNode;
}

/**
 * The locked-content backdrop that hosts whichever paywall card is active
 * (buy buttons, failure cards, checking spinner): a black canvas for photos,
 * the blurred thumbnail when one exists, or a plain panel otherwise.
 */
export default function PaywallFrame({ mediaType, thumbnailUrl, children }: PaywallFrameProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
      {mediaType === "photo" ? (
        // Single photo: black canvas with centered buttons
        <div className="flex min-h-[440px] flex-col items-center justify-center bg-black px-4 pt-20 pb-16">
          {children}
        </div>
      ) : thumbnailUrl ? (
        <div className="relative flex min-h-[440px] flex-col items-center justify-center px-4 pt-20 pb-16">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnailUrl}
            alt="Preview"
            className="absolute inset-0 h-full w-full object-cover opacity-40 blur-sm"
          />
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative z-10">{children}</div>
        </div>
      ) : (
        <div className="flex flex-col items-center px-4 pt-20 pb-16">{children}</div>
      )}
    </div>
  );
}
