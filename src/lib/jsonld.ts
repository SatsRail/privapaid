import type { InstanceConfig } from "@/config/instance";
import type { MediaType } from "@/models/Media";

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
    profile_image_url?: string;
    profile_image_id?: string;
  },
  config: InstanceConfig
): JsonLdBase {
  const siteUrl = `https://${config.domain}`;
  const imageUrl = channel.profile_image_id
    ? `${siteUrl}/api/images/${channel.profile_image_id}`
    : channel.profile_image_url || undefined;

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
    _id: string;
    name: string;
    description?: string;
    media_type: MediaType;
    thumbnail_url?: string;
    thumbnail_id?: string;
    created_at?: Date | string;
    updated_at?: Date | string;
  },
  channel: { name: string; slug: string },
  config: InstanceConfig
): JsonLdBase {
  const siteUrl = `https://${config.domain}`;
  const url = `${siteUrl}/c/${channel.slug}/${media._id}`;
  const imageUrl = media.thumbnail_id
    ? `${siteUrl}/api/images/${media.thumbnail_id}`
    : media.thumbnail_url || undefined;

  const shared = {
    name: media.name,
    url,
    ...(media.description && { description: media.description }),
    ...(imageUrl && { thumbnailUrl: imageUrl }),
    ...(media.created_at && { datePublished: new Date(media.created_at).toISOString() }),
    ...(media.updated_at && { dateModified: new Date(media.updated_at).toISOString() }),
  };

  switch (media.media_type) {
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
