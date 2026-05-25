import type { InstanceConfig } from "@/config/instance";
import type { MediaType } from "@prisma/client";

interface JsonLdBase {
  "@context": "https://schema.org";
  "@type": string;
  [key: string]: unknown;
}

export function buildWebSiteSchema(config: InstanceConfig): JsonLdBase {
  const siteUrl = `https://${config.domain}`;
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: config.name,
    url: siteUrl,
    potentialAction: {
      "@type": "SearchAction",
      target: `${siteUrl}/search?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };
}

export function buildOrganizationSchema(
  config: InstanceConfig
): JsonLdBase {
  const siteUrl = `https://${config.domain}`;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: config.name,
    url: siteUrl,
    ...(config.theme.logo && {
      logo: config.theme.logo.startsWith("/")
        ? `${siteUrl}${config.theme.logo}`
        : config.theme.logo,
    }),
  };
}

export function buildChannelSchema(
  channel: {
    name: string;
    slug: string;
    bio?: string;
    profileImageUrl?: string;
    id?: string;
    hasProfileImage?: boolean;
  },
  config: InstanceConfig
): JsonLdBase {
  const siteUrl = `https://${config.domain}`;
  const imageUrl = channel.hasProfileImage && channel.id
    ? `${siteUrl}/api/images/channel/${channel.id}`
    : channel.profileImageUrl || undefined;

  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: channel.name,
    url: `${siteUrl}/c/${channel.slug}`,
    ...(channel.bio && { description: channel.bio }),
    ...(imageUrl && { image: imageUrl }),
    isPartOf: {
      "@type": "WebSite",
      name: config.name,
      url: siteUrl,
    },
  };
}

export function buildMediaSchema(
  media: {
    id: string;
    name: string;
    description?: string;
    mediaType: MediaType;
    thumbnailUrl?: string;
    hasThumbnail?: boolean;
    createdAt?: Date | string;
    updatedAt?: Date | string;
  },
  channel: { name: string; slug: string },
  config: InstanceConfig
): JsonLdBase {
  const siteUrl = `https://${config.domain}`;
  const url = `${siteUrl}/c/${channel.slug}/${media.id}`;
  const imageUrl = media.hasThumbnail
    ? `${siteUrl}/api/images/media-thumbnail/${media.id}`
    : media.thumbnailUrl || undefined;

  const shared = {
    name: media.name,
    url,
    ...(media.description && { description: media.description }),
    ...(imageUrl && { thumbnailUrl: imageUrl }),
    ...(media.createdAt && { datePublished: new Date(media.createdAt).toISOString() }),
    ...(media.updatedAt && { dateModified: new Date(media.updatedAt).toISOString() }),
  };

  switch (media.mediaType) {
    case "video":
      return {
        "@context": "https://schema.org",
        "@type": "VideoObject",
        ...shared,
        ...(imageUrl && { thumbnailUrl: imageUrl }),
      };
    case "audio":
    case "podcast":
      return {
        "@context": "https://schema.org",
        "@type": "AudioObject",
        ...shared,
      };
    case "article":
      return {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: media.name,
        ...shared,
        ...(imageUrl && { image: imageUrl }),
        author: {
          "@type": "Person",
          name: channel.name,
        },
      };
    case "photo":
      return {
        "@context": "https://schema.org",
        "@type": "ImageObject",
        ...shared,
        ...(imageUrl && { image: imageUrl }),
      };
    default:
      return {
        "@context": "https://schema.org",
        "@type": "CreativeWork",
        ...shared,
      };
  }
}

export function buildBreadcrumbSchema(
  items: { name: string; url: string }[],
  config: InstanceConfig
): JsonLdBase {
  const siteUrl = `https://${config.domain}`;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url.startsWith("/") ? `${siteUrl}${item.url}` : item.url,
    })),
  };
}
