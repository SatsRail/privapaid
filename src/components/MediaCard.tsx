import Link from "next/link";
import { resolveImageUrl } from "@/lib/images";

interface MediaCardProps {
  channelSlug: string;
  channelName?: string;
  channelAvatarUrl?: string;
  channelAvatarId?: string;
  media: {
    _id: unknown;
    name: string;
    description: string;
    media_type: string;
    thumbnail_url: string;
    thumbnail_id?: string;
    preview_image_ids?: string[];
    comments_count: number;
    views_count?: number;
  };
  price?: { cents: number; currency: string };
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

const TYPE_LABELS: Record<string, string> = {
  video: "VIDEO",
  audio: "AUDIO",
  article: "ARTICLE",
  photo: "PHOTO",
  podcast: "PODCAST",
};

const TYPE_ICONS: Record<string, string> = {
  video: "\u25B6",
  audio: "\u266B",
  article: "\uD83D\uDCC4",
  photo: "\uD83D\uDDBC",
  podcast: "\uD83C\uDF99",
};

export default function MediaCard({
  channelSlug,
  channelName,
  channelAvatarUrl,
  channelAvatarId,
  media,
  price,
}: MediaCardProps) {
  const previewFallbackId = media.preview_image_ids?.[0];
  const thumbnailSrc =
    resolveImageUrl(media.thumbnail_id, media.thumbnail_url) ||
    (previewFallbackId ? `/api/images/${previewFallbackId}` : "");
  const avatarSrc = channelAvatarId || channelAvatarUrl
    ? resolveImageUrl(channelAvatarId, channelAvatarUrl || "")
    : null;

  return (
    <div className="group">
      {/* Thumbnail */}
      <Link
        href={`/c/${channelSlug}/${media._id}`}
        className="relative block aspect-video w-full overflow-hidden rounded-xl"
        style={{ backgroundColor: "var(--theme-bg-secondary)" }}
      >
        {thumbnailSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailSrc}
            alt={media.name}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-3xl" style={{ color: "var(--theme-text-secondary)" }}>
            {TYPE_ICONS[media.media_type] || "\u25B6"}
          </div>
        )}
        {/* Type badge overlay */}
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
          {TYPE_LABELS[media.media_type] || media.media_type.toUpperCase()}
        </span>
        {/* Price badge */}
        {price && (
          <span className="absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: "var(--theme-primary, #c9506b)" }}>
            {formatPrice(price.cents, price.currency)}
          </span>
        )}
      </Link>

      {/* Info row */}
      <div className="mt-3 flex gap-3">
        {/* Channel avatar */}
        {channelName && (
          <Link href={`/c/${channelSlug}`} className="shrink-0">
            {avatarSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarSrc}
                alt={channelName}
                className="h-9 w-9 rounded-full object-cover"
              />
            ) : (
              <div
                className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold"
                style={{
                  backgroundColor: "var(--theme-bg-secondary)",
                  color: "var(--theme-text-secondary)",
                }}
              >
                {channelName.charAt(0).toUpperCase()}
              </div>
            )}
          </Link>
        )}

        {/* Text info */}
        <div className="min-w-0 flex-1">
          <Link href={`/c/${channelSlug}/${media._id}`}>
            <h3
              className="line-clamp-2 text-sm font-medium leading-5 transition-colors"
              style={{ color: "var(--theme-heading)" }}
            >
              {media.name}
            </h3>
          </Link>
          {channelName && (
            <Link
              href={`/c/${channelSlug}`}
              className="mt-0.5 block text-xs transition-colors hover:text-[var(--theme-text)]"
              style={{ color: "var(--theme-text-secondary)" }}
            >
              {channelName}
            </Link>
          )}
          <div className="flex gap-3">
            {media.views_count != null && media.views_count > 0 && (
              <span
                className="text-xs"
                style={{ color: "var(--theme-text-secondary)" }}
              >
                {media.views_count} view{media.views_count !== 1 ? "s" : ""}
              </span>
            )}
            {media.comments_count > 0 && (
              <span
                className="text-xs"
                style={{ color: "var(--theme-text-secondary)" }}
              >
                {media.comments_count} comment{media.comments_count !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
