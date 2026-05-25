import { z } from "zod";
import { NextResponse } from "next/server";

/**
 * Parses a request body against a Zod schema.
 * Returns the validated data or a 400 NextResponse with field-level errors.
 */
export async function validateBody<T extends z.ZodType>(
  req: Request,
  schema: T
): Promise<z.infer<T> | NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", issues: [] },
      { status: 400 }
    );
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return NextResponse.json(
      { error: "Validation failed", issues },
      { status: 400 }
    );
  }

  return result.data;
}

/**
 * Type guard: returns true if the result is a NextResponse (validation failed).
 */
export function isValidationError(
  result: unknown
): result is NextResponse {
  return result instanceof NextResponse;
}

// ─── Reusable field patterns ────────────────────────────────────────

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color (#RRGGBB)");

const recordId = z.string().min(1, "ID is required");

const slug = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens");

// ─── Schemas ────────────────────────────────────────────────────────

export const schemas = {
  // Category create
  categoryCreate: z.object({
    name: z.string().min(1, "Name is required").max(100).transform((s) => s.trim()),
    slug: slug.optional(),
    position: z.number().int().nonnegative().optional(),
    active: z.boolean().optional(),
  }),

  // Category update
  categoryUpdate: z.object({
    name: z.string().min(1).max(100).transform((s) => s.trim()).optional(),
    slug: slug.optional(),
    position: z.number().int().nonnegative().optional(),
    active: z.boolean().optional(),
  }),

  // Channel create
  channelCreate: z.object({
    name: z.string().min(1, "Name is required").max(100).transform((s) => s.trim()),
    slug: slug.optional(),
    bio: z.string().max(2000).optional(),
    category_id: recordId.optional().nullable(),
    nsfw: z.boolean().optional(),
    profile_image_url: z.string().url().or(z.literal("")).optional(),
    profile_image_id: z.string().optional(),
    social_links: z.record(z.string(), z.string()).optional(),
  }),

  // Channel update
  channelUpdate: z.object({
    name: z.string().min(1).max(100).transform((s) => s.trim()).optional(),
    slug: slug.optional(),
    bio: z.string().max(2000).optional(),
    category_id: recordId.optional().nullable(),
    nsfw: z.boolean().optional(),
    profile_image_url: z.string().url().or(z.literal("")).optional(),
    profile_image_id: z.string().optional(),
    social_links: z.record(z.string(), z.string()).optional(),
    active: z.boolean().optional(),
    is_live: z.boolean().optional(),
    stream_url: z.string().url().or(z.literal("")).optional(),
  }),

  // Media create
  mediaCreate: z.object({
    channel_id: recordId,
    name: z.string().min(1, "Name is required").max(200).transform((s) => s.trim()),
    description: z.string().max(5000).optional(),
    source_url: z.string().min(1, "Source URL is required").max(500_000, "Content too long (500KB max)").transform((s) => s.trim()),
    media_type: z.enum(["video", "audio", "article", "photo", "podcast"]).optional(),
    thumbnail_url: z.string().optional(),
    thumbnail_id: z.string().optional(),
    position: z.number().int().nonnegative().optional(),
    // For photo media (envelope encryption): the per-photo DEK from the
    // /api/admin/photos upload response. Required when channel already has
    // ChannelProducts that must wrap this photo's DEK under their key.
    dek: z.string().optional(),
  }),

  // Media update
  mediaUpdate: z.object({
    name: z.string().min(1).max(200).transform((s) => s.trim()).optional(),
    description: z.string().max(5000).optional(),
    source_url: z.string().min(1).max(500_000, "Content too long (500KB max)").transform((s) => s.trim()).optional(),
    media_type: z.enum(["video", "audio", "article", "photo", "podcast"]).optional(),
    thumbnail_url: z.string().optional(),
    thumbnail_id: z.string().optional(),
    preview_image_ids: z.array(z.string()).max(6).optional(),
    position: z.number().int().nonnegative().optional(),
  }),

  // Checkout
  checkout: z.object({
    media_id: recordId,
    product_id: z.string().min(1, "product_id is required"),
  }),

  // Setup
  setup: z.object({
    instance_name: z.string().min(1, "Instance name is required").max(100).transform((s) => s.trim()),
    logo_url: z.string().url().or(z.literal("")).optional(),
    nsfw_enabled: z.boolean().optional(),
    theme_primary: hexColor.optional(),
    satsrail_api_key: z.string().min(1, "SatsRail API key is required").transform((s) => s.trim()),
    merchant_id: z.string().min(1, "Merchant ID is required").transform((s) => s.trim()),
    merchant_name: z.string().max(100).optional(),
    merchant_currency: z.string().max(10).optional(),
    merchant_locale: z.string().max(10).optional(),
  }),

  // Settings update
  settingsUpdate: z.object({
    instance_name: z.string().min(1).max(100).transform((s) => s.trim()).optional(),
    logo_url: z.string().url().or(z.literal("")).optional(),
    logo_image_id: z.string().optional(),
    about_text: z.string().max(5000).optional(),
    nsfw_enabled: z.boolean().optional(),
    adult_disclaimer: z.string().max(2000).optional(),
    theme_primary: hexColor.optional(),
    theme_bg: hexColor.optional(),
    theme_bg_secondary: hexColor.optional(),
    theme_text: hexColor.optional(),
    theme_text_secondary: hexColor.optional(),
    theme_heading: hexColor.optional(),
    theme_border: hexColor.optional(),
    theme_font: z.string().max(100).optional(),
    google_analytics_id: z.string().max(30).optional(),
    google_site_verification: z.string().max(100).optional(),
    sentry_dsn: z.string().max(500).optional(),
  }),

  // Like toggle — paired with POST /api/media/[id]/like.
  // Client tracks its own like state in localStorage; the server just
  // applies the +1 or -1 delta.
  likeAction: z.object({
    action: z.enum(["like", "unlike"]),
  }),

  // Comment create — anonymous body-only post, macaroon-gated upstream.
  commentCreate: z.object({
    body: z
      .string()
      .min(1, "Comment body required")
      .max(2000, "Comment too long (max 2000 chars)")
      .transform((s) => s.trim()),
  }),

  // Admin create
  adminCreate: z.object({
    email: z.string().email("Invalid email"),
    name: z.string().min(1, "Name is required").max(100),
    password: z.string().min(8, "Password must be at least 8 characters"),
    role: z.enum(["admin", "moderator"]),
  }),

  // Admin update
  adminUpdate: z.object({
    name: z.string().min(1).max(100).optional(),
    role: z.enum(["admin", "moderator"]).optional(),
    active: z.boolean().optional(),
    password: z.string().min(8).optional(),
  }),

  // Reorder (categories or media)
  reorder: z.object({
    items: z.array(
      z.object({
        id: recordId,
        position: z.number().int().nonnegative(),
      })
    ).min(1, "Items array is required"),
  }),

  // Product create (SatsRail proxy)
  productCreate: z.object({
    name: z.string().min(1, "Name is required").max(200).transform((s) => s.trim()),
    price_cents: z.number().int().positive("Price must be positive"),
    currency: z.string().max(10).optional(),
    access_duration_seconds: z.number().int().nonnegative().optional(),
    product_type_id: z.string().min(1, "Product type is required"),
  }),

  // Product update (SatsRail proxy)
  productUpdate: z.object({
    name: z.string().min(1).max(200).transform((s) => s.trim()).optional(),
    price_cents: z.number().int().positive().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    access_duration_seconds: z.number().int().nonnegative().optional(),
    product_type_id: z.string().min(1).optional(),
  }),

  // Product type create
  productTypeCreate: z.object({
    name: z.string().min(1, "Name is required").max(100).transform((s) => s.trim()),
  }),

  // Verify SatsRail API key
  verifyKey: z.object({
    satsrail_api_key: z.string().min(1, "API key is required").transform((s) => s.trim()),
  }),

  // Import: product sub-schema
  importMediaProduct: z.object({
    name: z.string().min(1).max(200),
    price_cents: z.number().int().positive(),
    currency: z.string().max(10).optional(),
    access_duration_seconds: z.number().int().nonnegative().optional(),
    external_ref: z.string().min(1).max(100).optional(),
  }),

  // Import: media item
  importMedia: z.object({
    ref: z.number().int().optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional().default(""),
    source_url: z.string().min(1),
    media_type: z
      .enum(["video", "audio", "article", "photo", "podcast"])
      .optional()
      .default("video"),
    thumbnail_url: z.string().optional().default(""),
    preview_image_urls: z.array(z.string()).max(6).optional().default([]),
    position: z.number().int().nonnegative().optional(),
    product: z
      .object({
        name: z.string().min(1).max(200),
        price_cents: z.number().int().positive(),
        currency: z.string().max(10).optional(),
        access_duration_seconds: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),

  // Channel-scoped import: media-only payload
  channelImportPayload: z.object({
    version: z.literal("1.0"),
    media: z
      .array(
        z.object({
          ref: z.number().int().optional(),
          name: z.string().min(1).max(200),
          description: z.string().max(5000).optional().default(""),
          source_url: z.string().min(1),
          media_type: z
            .enum(["video", "audio", "article", "photo", "podcast"])
            .optional()
            .default("video"),
          thumbnail_url: z.string().optional().default(""),
          preview_image_urls: z.array(z.string()).max(6).optional().default([]),
          position: z.number().int().nonnegative().optional(),
          product: z
            .object({
              name: z.string().min(1).max(200),
              price_cents: z.number().int().positive(),
              currency: z.string().max(10).optional(),
              access_duration_seconds: z.number().int().nonnegative().optional(),
              external_ref: z.string().min(1).max(100).optional(),
            })
            .optional(),
        })
      )
      .min(1, "At least one media item is required"),
  }),

  // Import: full payload
  importPayload: z.object({
    version: z.literal("1.0"),
    categories: z
      .array(
        z.object({
          slug,
          name: z.string().min(1).max(100),
          position: z.number().int().nonnegative().optional(),
          active: z.boolean().optional().default(true),
        })
      )
      .optional()
      .default([]),
    channels: z
      .array(
        z.object({
          slug,
          name: z.string().min(1).max(100),
          bio: z.string().max(2000).optional().default(""),
          category_slug: z.string().optional().nullable(),
          nsfw: z.boolean().optional().default(false),
          social_links: z.record(z.string(), z.string()).optional().default({}),
          profile_image_url: z.string().optional().default(""),
          active: z.boolean().optional().default(true),
          product: z
            .object({
              name: z.string().min(1).max(200),
              price_cents: z.number().int().positive(),
              currency: z.string().max(10).optional(),
              access_duration_seconds: z.number().int().nonnegative().optional(),
              external_ref: z.string().min(1).max(100).optional(),
            })
            .optional(),
          media: z
            .array(
              z.object({
                ref: z.number().int().optional(),
                name: z.string().min(1).max(200),
                description: z.string().max(5000).optional().default(""),
                source_url: z.string().min(1),
                media_type: z
                  .enum(["video", "audio", "article", "photo", "podcast"])
                  .optional()
                  .default("video"),
                thumbnail_url: z.string().optional().default(""),
                preview_image_urls: z.array(z.string()).max(6).optional().default([]),
                position: z.number().int().nonnegative().optional(),
                product: z
                  .object({
                    name: z.string().min(1).max(200),
                    price_cents: z.number().int().positive(),
                    currency: z.string().max(10).optional(),
                    access_duration_seconds: z.number().int().nonnegative().optional(),
                    external_ref: z.string().min(1).max(100).optional(),
                  })
                  .optional(),
              })
            )
            .optional()
            .default([]),
        })
      )
      .optional()
      .default([]),
  }),
};
