import Link from "next/link";
import Badge from "@/components/ui/Badge";
import { resolveImageUrl } from "@/lib/images";

interface ChannelCardProps {
  channel: {
    _id: unknown;
    slug: string;
    name: string;
    bio: string;
    profile_image_url: string;
    profile_image_id?: string;
    media_count: number;
    nsfw: boolean;
    theme: string;
  };
}

export default function ChannelCard({ channel }: ChannelCardProps) {
  const avatarSrc = resolveImageUrl(channel.profile_image_id, channel.profile_image_url);

  return (
    <Link
      href={`/c/${channel.slug}`}
      className="group block rounded-xl p-4 transition-colors hover:bg-[var(--theme-bg-secondary)]"
    >
      <div className="flex items-start gap-3">
        {avatarSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarSrc}
            alt={channel.name}
            className="h-12 w-12 rounded-full object-cover"
          />
        ) : (
          <div
            className="flex h-12 w-12 items-center justify-center rounded-full text-lg font-bold"
            style={{
              backgroundColor: "var(--theme-bg-secondary)",
              color: "var(--theme-text-secondary)",
            }}
          >
            {channel.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3
            className="truncate font-semibold transition-colors group-hover:text-[var(--theme-link)]"
            style={{ color: "var(--theme-heading)" }}
          >
            {channel.name}
          </h3>
          {channel.bio && (
            <p className="mt-0.5 line-clamp-2 text-sm" style={{ color: "var(--theme-text-secondary)" }}>
              {channel.bio}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: "var(--theme-text-secondary)" }}>
            <span>{channel.media_count} media</span>
            {channel.nsfw && <Badge color="pink">NSFW</Badge>}
          </div>
        </div>
      </div>
    </Link>
  );
}
