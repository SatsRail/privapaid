# Content Import

Populate your instance from a JSON file. Two flavors: **whole-site import** (categories + channels + media in one pass) and **channel import** (media added to an existing channel).

## Whole-Site Import

**Admin → Import / Export.** Upload a JSON file matching this shape:

```json
{
  "version": "1.0",
  "categories": [
    { "slug": "bitcoin-education", "name": "Bitcoin Education", "position": 1 }
  ],
  "channels": [
    {
      "slug": "beginner",
      "name": "Level 1 — Beginner",
      "bio": "Start here.",
      "category_slug": "bitcoin-education",
      "nsfw": false,
      "product": {
        "name": "Full Channel Access",
        "price_cents": 500,
        "currency": "USD",
        "access_duration_seconds": 2592000
      },
      "media": [
        {
          "ref": 1,
          "name": "What is Bitcoin?",
          "source_url": "https://www.youtube.com/watch?v=example",
          "media_type": "video",
          "position": 1,
          "product": {
            "name": "What is Bitcoin? — Individual",
            "price_cents": 100,
            "currency": "USD",
            "access_duration_seconds": 604800
          }
        }
      ]
    }
  ]
}
```

## Channel Import

**Admin → Channels → [channel] → Import.** The file contains only a media array:

```json
{
  "version": "1.0",
  "media": [
    {
      "ref": 1,
      "name": "Episode Title",
      "source_url": "https://www.youtube.com/watch?v=example",
      "media_type": "video",
      "position": 1,
      "product": {
        "name": "Episode Title",
        "price_cents": 100,
        "currency": "USD",
        "access_duration_seconds": 604800
      }
    }
  ]
}
```

## Importable media types

| `media_type` | `source_url` holds | Notes |
|---|---|---|
| `video` | Direct file URL or embed (YouTube, Vimeo, Twitch, Bunny, Cloudflare Stream, Mux, Dailymotion) | Auto-detects host |
| `audio` | Direct audio URL (`.mp3`/`.wav`/`.flac`/`.aac`) | Renders in `<audio>` |
| `article` | Markdown text **or** a URL | Server envelope-encrypts the markdown at import time; URL articles render as an external link card |
| `podcast` | Audio URL | Same as audio plus JSON-LD podcast metadata |
| `photo` | **NOT importable via JSON** | Photos require uploading the raw bytes through `/api/admin/photos` so the EncryptedEnvelope row and DEK can be created. |

## Idempotency

Re-importing with the same `slug` (categories/channels) or `ref` (media) **updates** existing records rather than creating duplicates. This makes the import flow safe to re-run after fixing data in the source JSON.

For articles specifically: re-importing the same article ref with a new `source_url` (markdown body) re-encrypts the envelope bytes under the existing DEK. The per-product blob doesn't change (because the DEK didn't change), so re-import is much faster than the initial import.

## Products on import

Each media item or channel can include an optional `product` block. The import:

1. Creates a SatsRail product via the merchant API
2. Fetches the product's encryption key
3. Encrypts the media's plaintext (URL for url-backed kinds; raw DEK for envelope kinds) under the key
4. Writes the encrypted blob to `MediaEncryptedBlob.encryptedSource`

If the SatsRail API rate-limits during import, the importer auto-retries with backoff. Network failures during import surface in the import results JSON.

## Limits

| Field | Cap |
|---|---|
| `source_url` length (videos/audio/podcast) | 8 KB |
| `source_url` length (article markdown) | 500 KB |
| Media items per import batch | 100 |

## See also

- [[Operator Playbook]] — env vars needed for import (`SATSRAIL_API_URL`, merchant key in setup)
- [Architecture (docs/ENCRYPTION.md)](https://github.com/SatsRail/privapaid/blob/main/docs/ENCRYPTION.md) — how `source_url` becomes `encryptedSource`
