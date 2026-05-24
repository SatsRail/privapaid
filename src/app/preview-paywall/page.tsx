"use client";

import PaymentWall from "@/components/PaymentWall";
import type { MediaAccess } from "@/lib/use-media-access";

const sampleProducts = [
  {
    productId: "p1",
    encryptedBlob: "x",
    name: "Bunny Stream — CDN Demo",
    priceCents: 1,
    currency: "USD",
    accessDurationSeconds: 7 * 24 * 60 * 60,
  },
  {
    productId: "p2",
    encryptedBlob: "x",
    name: "Channel Access",
    priceCents: 1,
    currency: "USD",
    accessDurationSeconds: 24 * 60 * 60,
  },
];

export default function PaywallPreviewPage() {
  const expiredAccess: MediaAccess = {
    status: "inactive",
    reason: "no_cookie",
    expiredAt: new Date("2026-05-15T19:37:00Z"),
  };

  const noBannerAccess: MediaAccess = {
    status: "inactive",
    reason: "no_cookie",
  };

  return (
    <div className="mx-auto max-w-6xl space-y-12 p-8">
      <div>
        <h2 className="mb-4 text-base font-semibold text-zinc-200">
          Expired (with banner)
        </h2>
        <PaymentWall
          mediaId="m1"
          products={sampleProducts}
          access={expiredAccess}
          onAccessClaim={() => {}}
          mediaType="video"
          thumbnailUrl="https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&auto=format"
        />
      </div>
      <div>
        <h2 className="mb-4 text-base font-semibold text-zinc-200">
          First-time visitor (no banner)
        </h2>
        <PaymentWall
          mediaId="m2"
          products={sampleProducts}
          access={noBannerAccess}
          onAccessClaim={() => {}}
          mediaType="video"
          thumbnailUrl="https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&auto=format"
        />
      </div>
      <div>
        <h2 className="mb-4 text-base font-semibold text-zinc-200">
          No thumbnail (plain background)
        </h2>
        <PaymentWall
          mediaId="m3"
          products={sampleProducts}
          access={noBannerAccess}
          onAccessClaim={() => {}}
          mediaType="article"
        />
      </div>
    </div>
  );
}
