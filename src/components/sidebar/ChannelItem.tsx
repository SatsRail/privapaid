"use client";

import Link from "next/link";
import { resolveImageUrl } from "@/lib/images";
import type { SidebarChannel } from "./types";

interface ChannelItemProps {
  channel: SidebarChannel;
  active: boolean;
  collapsed: boolean;
}

/** One channel row: avatar (or initial), name, and the live dot. */
export default function ChannelItem({ channel, active, collapsed }: ChannelItemProps) {
  const avatarSrc = resolveImageUrl(channel.profile_image_id, channel.profile_image_url);

  return (
    <Link
      href={`/c/${channel.slug}`}
      className={`flex items-center gap-5 rounded-lg px-3 py-2 text-sm transition-colors ${
        active ? "bg-[var(--theme-bg-secondary)]" : "hover:bg-[var(--theme-bg-secondary)]"
      }`}
      title={collapsed ? channel.name : undefined}
    >
      {avatarSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarSrc}
          alt={channel.name}
          className="h-6 w-6 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
          style={{
            backgroundColor: "var(--theme-bg-secondary)",
            color: "var(--theme-text-secondary)",
          }}
        >
          {channel.name.charAt(0).toUpperCase()}
        </div>
      )}
      {!collapsed && (
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span
            className="truncate"
            style={{
              color: active ? "var(--theme-heading)" : "var(--theme-text)",
            }}
          >
            {channel.name}
          </span>
          {channel.is_live && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="Live" />
          )}
        </div>
      )}
    </Link>
  );
}
