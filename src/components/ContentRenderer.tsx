"use client";

/**
 * ContentRenderer — renders decrypted media content after purchase.
 *
 * ARCHITECTURE NOTE — DO NOT REFACTOR TO PURE REACT
 *
 * ContentRendererDOM deliberately uses imperative DOM APIs (createElement,
 * attachShadow) rather than React JSX. This is a load-bearing security
 * decision, not a style choice:
 *
 * 1. **Closed Shadow DOM for XSS isolation.** Creator-authored HTML (articles,
 *    blog posts) is untrusted content. Rendering it inside a closed shadow root
 *    (`attachShadow({ mode: "closed" })`) prevents scripts in the host page
 *    from reaching into the sanitized content, and prevents injected content
 *    from accessing the host page's DOM, cookies, or React state.
 *
 * 2. **DOMPurify requires raw HTML strings.** Sanitization happens on the raw
 *    HTML string *before* insertion into the shadow DOM. React's
 *    `dangerouslySetInnerHTML` would bypass shadow DOM isolation entirely and
 *    inject directly into the main document tree.
 *
 * 3. **Blob URLs for binary media.** Video, audio, and image blobs use
 *    `URL.createObjectURL()` which returns a URL that must be revoked on
 *    cleanup. This lifecycle is simpler with imperative DOM than React refs.
 *
 * The `:host` styles in the shadow DOM style block are inline because external
 * stylesheets (including Tailwind) cannot penetrate a closed shadow root.
 */

import { useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { detectMimeType, bytesToUrl } from "@/lib/client-crypto";
import * as Sentry from "@sentry/nextjs";

// Article-only markdown instance. Custom link renderer adds target="_blank" and
// rel="noopener noreferrer" so external links don't navigate the host page away
// from the article when clicked inside the closed shadow root.
const articleMarkdown = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

interface ContentRendererProps {
  decryptedBytes: Uint8Array;
  mediaType: string;
}

/** Check if a URL points to a known embeddable video host or streaming service */
function isEmbedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|iframe\.mediadelivery\.net|bunny\.net|stream\.mux\.com|mux\.com|customer-[a-z0-9]+\.cloudflarestream\.com|cloudflarestream\.com|videodelivery\.net|player\.live-video\.net/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Convert a video URL to its embeddable form.
 * Handles YouTube, Vimeo, Dailymotion, Twitch, Bunny Stream,
 * Mux, Cloudflare Stream, and AWS IVS.
 */
function tryYouTubeEmbed(u: URL, originalUrl: string): string | null {
  const isYouTube = /youtube\.com/.test(u.hostname);

  if (isYouTube && u.pathname === "/watch" && u.searchParams.has("v")) {
    const videoId = u.searchParams.get("v");
    const start = u.searchParams.get("t");
    return start
      ? `https://www.youtube-nocookie.com/embed/${videoId}?start=${Number.parseInt(start, 10)}`
      : `https://www.youtube-nocookie.com/embed/${videoId}`;
  }

  if (isYouTube) {
    const shortsMatch = u.pathname.match(/^\/shorts\/([^/?]+)/);
    if (shortsMatch) return `https://www.youtube-nocookie.com/embed/${shortsMatch[1]}`;
  }

  if (isYouTube && u.pathname.startsWith("/embed/")) {
    return originalUrl.replace("youtube.com", "youtube-nocookie.com");
  }

  if (u.hostname === "youtu.be") {
    return `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`;
  }

  return null;
}

function tryOtherEmbeds(u: URL): string | null {
  if (u.hostname === "vimeo.com" || u.hostname === "www.vimeo.com") {
    const videoId = u.pathname.match(/^\/(\d+)/)?.[1];
    if (videoId) return `https://player.vimeo.com/video/${videoId}`;
  }

  if (/dailymotion\.com/.test(u.hostname)) {
    const videoMatch = u.pathname.match(/^\/video\/([^/?]+)/);
    if (videoMatch) return `https://www.dailymotion.com/embed/video/${videoMatch[1]}`;
  }

  if (/twitch\.tv/.test(u.hostname)) {
    const parent = typeof globalThis.window !== "undefined" ? globalThis.window.location.hostname : "";
    const videoMatch = u.pathname.match(/^\/videos\/(\d+)/);
    if (videoMatch) return `https://player.twitch.tv/?video=${videoMatch[1]}&parent=${parent}`;
    const channelMatch = u.pathname.match(/^\/([a-zA-Z0-9_]+)\/?$/);
    if (channelMatch) return `https://player.twitch.tv/?channel=${channelMatch[1]}&parent=${parent}`;
  }

  return null;
}

function toEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    return tryYouTubeEmbed(u, url) || tryOtherEmbeds(u) || url;
  } catch {
    return url;
  }
}

/** Check if URL points directly to a video/audio file */
function isDirectMediaUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(mp4|webm|ogg|m3u8|mpd|mp3|wav|flac|aac)(\?|$)/.test(pathname);
  } catch {
    return false;
  }
}

/** Check if URL points to a PDF file */
function isPdfUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.pdf(\?|$)/.test(pathname);
  } catch {
    return false;
  }
}

/** Open an imperative lightbox overlay for a single image URL */
function openImageLightbox(url: string): void {
  const overlay = document.createElement("div");
  overlay.setAttribute("data-lightbox-overlay", "");
  overlay.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/90";
  overlay.style.cursor = "zoom-out";

  const closeBtn = document.createElement("button");
  closeBtn.className = "absolute right-4 top-4 z-10 rounded-full bg-black/50 p-2 text-white hover:bg-black/70";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  const fullImg = document.createElement("img");
  fullImg.src = url;
  fullImg.alt = "Full size";
  fullImg.className = "max-h-[90vh] max-w-[90vw] rounded-lg object-contain";

  function close() {
    document.body.style.overflow = "";
    overlay.remove();
    document.removeEventListener("keydown", handleKey);
  }
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  overlay.addEventListener("click", close);
  fullImg.addEventListener("click", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); close(); });
  document.addEventListener("keydown", handleKey);
  document.body.style.overflow = "hidden";

  overlay.appendChild(closeBtn);
  overlay.appendChild(fullImg);
  document.body.appendChild(overlay);
}

export default function ContentRenderer({
  decryptedBytes,
  mediaType,
}: ContentRendererProps) {
  return <ContentRendererDOM decryptedBytes={decryptedBytes} mediaType={mediaType} />;
}

/** DOM-based renderer for video, audio, embeds, images, and HTML content */
function ContentRendererDOM({
  decryptedBytes,
  mediaType,
}: ContentRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !decryptedBytes.length) return;

    const mime = detectMimeType(decryptedBytes);
    const container = containerRef.current;

    // Blob URLs created during this render — revoked on cleanup. We keep
    // them alive across `img.onload` because the lightbox click handler
    // reuses the same URL when the user clicks to zoom.
    const blobUrls: string[] = [];

    // Clear previous content
    container.innerHTML = "";

    if (mime === "text/url") {
      const url = bytesToUrl(decryptedBytes).trim();

      // Decide: embed iframe for known video hosts, <video>/<audio> for direct media URLs,
      // or fall back based on mediaType
      if (isEmbedUrl(url)) {
        const iframe = document.createElement("iframe");
        iframe.src = toEmbedUrl(url);
        iframe.className = "w-full aspect-video rounded-lg";
        iframe.allow = "autoplay; fullscreen; encrypted-media";
        iframe.allowFullscreen = true;
        iframe.onerror = () => {
          Sentry.captureException(new Error(`Iframe failed to load: ${url}`), {
            tags: { context: "ContentRenderer.iframe" },
          });
        };
        container.appendChild(iframe);
      } else if (isDirectMediaUrl(url) || mediaType === "video") {
        // Direct video/audio URL — use native element
        const video = document.createElement("video");
        video.src = url;
        video.controls = true;
        video.className = "w-full rounded-lg";
        video.onerror = () => {
          Sentry.captureException(new Error(`Video element failed to load: ${url}`), {
            tags: { context: "ContentRenderer.video" },
            extra: { mediaType, url },
          });
          container.innerHTML = "";
          const msg = document.createElement("div");
          msg.className = "flex items-center justify-center h-64 text-gray-400 text-sm";
          msg.textContent = "This video could not be loaded. The source may be unavailable.";
          container.appendChild(msg);
        };
        container.appendChild(video);
      } else if (mediaType === "audio") {
        const audio = document.createElement("audio");
        audio.src = url;
        audio.controls = true;
        audio.className = "w-full";
        audio.onerror = () => {
          Sentry.captureException(new Error(`Audio element failed to load: ${url}`), {
            tags: { context: "ContentRenderer.audio" },
            extra: { mediaType, url },
          });
        };
        container.appendChild(audio);
      } else if (mediaType === "image") {
        // Single image URL (e.g. legacy URL-based image media)
        const img = document.createElement("img");
        img.src = url;
        img.alt = "Content";
        img.className = "max-w-full rounded-lg cursor-pointer";
        img.addEventListener("click", () => openImageLightbox(url));
        img.onerror = () => {
          Sentry.captureException(new Error(`Image URL failed to load: ${url}`), {
            tags: { context: "ContentRenderer.imageUrl" },
            extra: { mediaType, url },
          });
          container.innerHTML = "";
          const msg = document.createElement("div");
          msg.className = "flex items-center justify-center h-64 text-gray-400 text-sm";
          msg.textContent = "This image could not be loaded. The source may be unavailable.";
          container.appendChild(msg);
        };
        container.appendChild(img);
      } else if (isPdfUrl(url)) {
        // PDF URL — use <object> with fallback link
        const wrapper = document.createElement("div");
        wrapper.className = "flex flex-col items-center gap-4";

        const obj = document.createElement("object");
        obj.data = url;
        obj.type = "application/pdf";
        obj.className = "w-full rounded-lg";
        obj.style.height = "80vh";

        const fallbackLink = document.createElement("a");
        fallbackLink.href = url;
        fallbackLink.target = "_blank";
        fallbackLink.rel = "noopener noreferrer";
        fallbackLink.className = "text-[var(--theme-primary)] underline text-sm";
        fallbackLink.textContent = "Open PDF in new tab";
        obj.appendChild(fallbackLink);

        wrapper.appendChild(obj);
        container.appendChild(wrapper);
      } else if (mediaType === "article") {
        // Article URL — most sites block iframing, show a link card
        const card = document.createElement("div");
        card.className = "flex flex-col items-center justify-center gap-4 rounded-lg border border-zinc-700 bg-zinc-900 p-8";

        const icon = document.createElement("div");
        icon.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-400"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
        card.appendChild(icon);

        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "inline-flex items-center gap-2 rounded-lg bg-[var(--theme-primary)] px-5 py-2.5 text-sm font-medium text-black hover:opacity-90";
        link.textContent = "Open article";
        card.appendChild(link);

        const hint = document.createElement("p");
        hint.className = "text-xs text-zinc-500";
        hint.textContent = "Content will open in a new browser tab.";
        card.appendChild(hint);

        container.appendChild(card);
      } else {
        // Unknown URL type — try iframe
        const iframe = document.createElement("iframe");
        iframe.src = url;
        iframe.className = "w-full aspect-video rounded-lg";
        iframe.allow = "autoplay; fullscreen; encrypted-media";
        iframe.allowFullscreen = true;
        container.appendChild(iframe);
      }
    } else if (mime.startsWith("image/")) {
      const blob = new Blob([decryptedBytes.buffer as ArrayBuffer], { type: mime });
      const url = URL.createObjectURL(blob);
      blobUrls.push(url);
      const img = document.createElement("img");
      img.src = url;
      // Cap the rendered height so a tall portrait doesn't push the rest of
      // the page (sidebar comments, description) off-screen. `object-contain`
      // preserves aspect ratio within the constrained box. Click opens the
      // full-resolution lightbox. No `bg-*` here — the outer container is
      // transparent for photos so the page background shows through where
      // the image doesn't fill the column.
      img.className =
        "block mx-auto max-w-full max-h-[80vh] rounded-lg object-contain cursor-zoom-in";
      img.addEventListener("click", () => openImageLightbox(url));
      img.onerror = () => {
        Sentry.captureException(new Error("Image blob failed to render"), {
          tags: { context: "ContentRenderer.image" },
          extra: { mime, byteLength: decryptedBytes.length },
        });
      };
      container.appendChild(img);
    } else if (mime.startsWith("video/")) {
      const blob = new Blob([decryptedBytes.buffer as ArrayBuffer], { type: mime });
      const url = URL.createObjectURL(blob);
      blobUrls.push(url);
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.className = "w-full rounded-lg";
      video.onerror = () => {
        Sentry.captureException(new Error("Video blob failed to render"), {
          tags: { context: "ContentRenderer.videoBlob" },
          extra: { mime, byteLength: decryptedBytes.length },
        });
      };
      container.appendChild(video);
    } else if (mime.startsWith("audio/")) {
      const blob = new Blob([decryptedBytes.buffer as ArrayBuffer], { type: mime });
      const url = URL.createObjectURL(blob);
      blobUrls.push(url);
      const audio = document.createElement("audio");
      audio.src = url;
      audio.controls = true;
      audio.className = "w-full";
      audio.onerror = () => {
        Sentry.captureException(new Error("Audio blob failed to render"), {
          tags: { context: "ContentRenderer.audioBlob" },
          extra: { mime, byteLength: decryptedBytes.length },
        });
      };
      container.appendChild(audio);
    } else {
      // Treat as HTML content — sanitize to prevent XSS, render in shadow DOM.
      // For mediaType "article", the decrypted text is markdown — parse it first.
      const rawText = new TextDecoder().decode(decryptedBytes);
      const text =
        mediaType === "article"
          ? (articleMarkdown.parse(rawText) as string)
          : rawText;
      const shadow = container.attachShadow({ mode: "closed" });

      // Inject article styles so content is readable on dark backgrounds
      const style = document.createElement("style");
      style.textContent = `
        :host {
          color: #e4e4e7;
          font-family: Georgia, 'Times New Roman', serif;
          font-size: 1.125rem;
          line-height: 1.8;
        }
        * { box-sizing: border-box; }
        h1, h2, h3, h4, h5, h6 {
          font-family: system-ui, -apple-system, sans-serif;
          color: #fafafa;
          margin: 1.5em 0 0.5em;
          line-height: 1.3;
        }
        h1 { font-size: 2rem; }
        h2 { font-size: 1.5rem; }
        h3 { font-size: 1.25rem; }
        p { margin: 0 0 1em; }
        a { color: var(--theme-primary, #d4a017); text-decoration: underline; }
        a:hover { opacity: 0.8; }
        blockquote {
          border-left: 3px solid #52525b;
          margin: 1em 0;
          padding: 0.5em 1em;
          color: #a1a1aa;
          font-style: italic;
        }
        pre, code {
          font-family: 'SF Mono', Monaco, Consolas, monospace;
          font-size: 0.875em;
          background: #18181b;
          border-radius: 4px;
        }
        pre { padding: 1em; overflow-x: auto; margin: 1em 0; }
        code { padding: 0.15em 0.3em; }
        pre code { padding: 0; background: none; }
        img { max-width: 100%; height: auto; border-radius: 8px; margin: 1em 0; }
        ul, ol { margin: 0 0 1em; padding-left: 1.5em; }
        li { margin-bottom: 0.25em; }
        hr { border: none; border-top: 1px solid #3f3f46; margin: 2em 0; }
        table { width: 100%; border-collapse: collapse; margin: 1em 0; }
        th, td { border: 1px solid #3f3f46; padding: 0.5em 0.75em; text-align: left; }
        th { background: #18181b; color: #fafafa; }
      `;
      shadow.appendChild(style);

      const wrapper = document.createElement("div");
      // ADD_ATTR: ["target"] keeps the target="_blank" attribute the marked
      // renderer adds to links; DOMPurify strips it by default.
      wrapper.innerHTML = DOMPurify.sanitize(text, { ADD_ATTR: ["target"] });
      shadow.appendChild(wrapper);
    }

    return () => {
      container.innerHTML = "";
      // Remove any lingering lightbox overlay
      document.querySelector("[data-lightbox-overlay]")?.remove();
      document.body.style.overflow = "";
      // Release blob URLs allocated during this render. We deliberately did
      // NOT revoke on `onload` so the lightbox click handler can still open
      // the same URL — cleanup on unmount / decryptedBytes change is the
      // correct lifecycle boundary.
      for (const u of blobUrls) URL.revokeObjectURL(u);
    };
  }, [decryptedBytes, mediaType]);

  // Background + sizing strategy:
  //   • article + podcast      → transparent + padding (text content sits on
  //                              the page background; black tile looks heavy)
  //   • photo                  → transparent (let the page show through any
  //                              letterbox gap from object-contain — black
  //                              bars next to a photo look unfinished)
  //   • audio                  → black tile, no aspect constraint
  //   • video / iframe / other → black + max-w-[1280px], left-aligned.
  //                              YouTube's standard watch-page video tops out
  //                              at ~1280px on desktop; we cap to match but
  //                              hug the left edge of the column so the player
  //                              lines up with the title/meta block beneath it
  //                              rather than floating centered. The iframe is
  //                              already `aspect-video w-full` and the native
  //                              <video> intrinsic ratio fills inside the cap,
  //                              so the box is always 16:9 in practice for
  //                              embeds.
  const isText = mediaType === "article" || mediaType === "podcast";
  const isPhoto = mediaType === "photo";
  const isAudio = mediaType === "audio";

  let containerClass: string;
  if (isText) {
    containerClass = "min-h-[200px] rounded-lg p-6";
  } else if (isPhoto) {
    containerClass = "min-h-[200px] overflow-hidden rounded-lg";
  } else if (isAudio) {
    containerClass = "min-h-[80px] rounded-lg bg-black p-4";
  } else {
    containerClass =
      "min-h-[200px] max-w-[1280px] overflow-hidden rounded-lg bg-black";
  }

  return <div ref={containerRef} className={containerClass} />;
}
