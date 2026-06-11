// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

// --- Mocks (must come before import of component) ---

const mockDetectMimeType = vi.fn().mockReturnValue("text/html");
const mockBytesToUrl = vi.fn().mockReturnValue("https://example.com/video");
const mockCaptureException = vi.fn();

vi.mock("@/lib/client-crypto", () => ({
  detectMimeType: (...args: unknown[]) => mockDetectMimeType(...args),
  bytesToUrl: (...args: unknown[]) => mockBytesToUrl(...args),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock("dompurify", () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

const { mockMarkedParse } = vi.hoisted(() => ({
  mockMarkedParse: vi.fn((text: string) => `<MD>${text}</MD>`),
}));
vi.mock("marked", () => {
  class Marked {
    parse = mockMarkedParse;
  }
  return { Marked };
});

import ContentRenderer from "@/components/ContentRenderer";

// Helper: encode a string as Uint8Array
function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

describe("ContentRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset URL.createObjectURL / revokeObjectURL
    global.URL.createObjectURL = vi.fn().mockReturnValue("blob:fake-url");
    global.URL.revokeObjectURL = vi.fn();
  });

  // -------------------------------------------------------
  // ContentRendererDOM — URL-based content (text/url mime)
  // -------------------------------------------------------
  describe("URL-based content (text/url)", () => {
    it("renders iframe for YouTube embed URL", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://www.youtube.com/watch?v=abc123");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("https://www.youtube.com/watch?v=abc123")} mediaType="video" />
      );

      // useEffect runs synchronously in jsdom after render with act
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("youtube-nocookie.com/embed/abc123");
    });

    it("renders iframe for YouTube shorts URL", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://www.youtube.com/shorts/xyz789");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("youtube-nocookie.com/embed/xyz789");
    });

    it("renders iframe for YouTube embed already /embed/ path", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://www.youtube.com/embed/abc123");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("youtube-nocookie.com/embed/abc123");
    });

    it("renders iframe for youtu.be short link", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://youtu.be/shortId");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("youtube-nocookie.com/embed/shortId");
    });

    it("handles YouTube URL with start time parameter", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://www.youtube.com/watch?v=abc123&t=120");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("start=120");
    });

    it("renders iframe for Vimeo URL", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://vimeo.com/123456");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("player.vimeo.com/video/123456");
    });

    it("renders iframe for Dailymotion URL", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://www.dailymotion.com/video/x8abc12");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("dailymotion.com/embed/video/x8abc12");
    });

    it("renders iframe for Twitch video URL", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://www.twitch.tv/videos/123456");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("player.twitch.tv/?video=123456");
    });

    it("renders iframe for Twitch channel URL", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://www.twitch.tv/mychannel");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("player.twitch.tv/?channel=mychannel");
    });

    it("renders video element for direct media URL", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://cdn.example.com/video.mp4");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const video = container.querySelector("video");
      expect(video).toBeTruthy();
      expect(video?.src).toContain("video.mp4");
      expect(video?.controls).toBe(true);
    });

    it("renders video element for mediaType=video with non-embed URL", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://custom-cdn.example.com/stream");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const video = container.querySelector("video");
      expect(video).toBeTruthy();
    });

    it("renders audio element for mediaType=audio", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://example.com/podcast");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="audio" />
      );
      const audio = container.querySelector("audio");
      expect(audio).toBeTruthy();
      expect(audio?.controls).toBe(true);
    });

    it("renders link card for article URL type", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://example.com/something");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="article" />
      );
      const link = container.querySelector("a");
      expect(link).toBeTruthy();
      expect(link?.href).toContain("example.com/something");
      expect(link?.target).toBe("_blank");
    });

    it("renders fallback iframe for unknown URL type", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://example.com/something");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video_stream" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("example.com/something");
    });

    it("handles video onerror by showing error message", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://cdn.example.com/video.mp4");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );

      const video = container.querySelector("video");
      expect(video).toBeTruthy();

      // Trigger onerror
      act(() => {
        if (video?.onerror) (video.onerror as () => void)();
      });

      expect(mockCaptureException).toHaveBeenCalled();
      // After error, video is replaced with an error message
      expect(container.querySelector("video")).toBeNull();
      expect(container.textContent).toContain("could not be loaded");
    });

    it("handles audio onerror by reporting to Sentry", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      // Use a URL that is NOT a direct media URL and NOT an embed URL
      mockBytesToUrl.mockReturnValue("https://example.com/podcast-stream");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="audio" />
      );

      const audio = container.querySelector("audio") as HTMLAudioElement;
      expect(audio).toBeTruthy();
      // onerror is set as a property, not addEventListener, so call it directly
      act(() => {
        if (audio.onerror) (audio.onerror as () => void)();
      });
      expect(mockCaptureException).toHaveBeenCalled();
    });

    it("handles direct media URL with various extensions", () => {
      for (const ext of ["webm", "ogg", "m3u8", "mp3", "wav"]) {
        mockDetectMimeType.mockReturnValue("text/url");
        mockBytesToUrl.mockReturnValue(`https://cdn.example.com/file.${ext}`);

        const { container, unmount } = render(
          <ContentRenderer decryptedBytes={toBytes("url")} mediaType="other" />
        );
        // Direct media URLs get a video or audio element (isDirectMediaUrl returns true)
        const media = container.querySelector("video") || container.querySelector("audio");
        expect(media).toBeTruthy();
        unmount();
      }
    });

    it("passes through Bunny Stream URLs as-is", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://iframe.mediadelivery.net/embed/123/abc");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
      expect(iframe?.src).toContain("iframe.mediadelivery.net");
    });

    it("passes through Cloudflare Stream URLs as-is", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://customer-abc123.cloudflarestream.com/video");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
    });
  });

  // -------------------------------------------------------
  // ContentRendererDOM — Binary blob content
  // -------------------------------------------------------
  describe("binary blob content", () => {
    it("renders image for image/ mime type", () => {
      mockDetectMimeType.mockReturnValue("image/jpeg");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0xff, 0xd8, 0xff])} mediaType="image" />
      );
      const img = container.querySelector("img");
      expect(img).toBeTruthy();
      expect(img?.src).toBe("blob:fake-url");
    });

    it("photo media renders with a transparent container (no black letterbox)", () => {
      // Black bars next to a portrait photo look unfinished. The container
      // must not paint a background — only video/audio players need it.
      mockDetectMimeType.mockReturnValue("image/png");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x89, 0x50, 0x4e, 0x47])} mediaType="photo" />
      );
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.className).not.toContain("bg-black");
      // …and the image itself doesn't paint a background either.
      const img = container.querySelector("img");
      expect(img?.className).not.toContain("bg-black");
    });

    it("video media keeps bg-black for letterboxing", () => {
      // Letterboxing matters for video — black bars around a 16:9 player on
      // a wider/narrower viewport are the conventional look.
      mockDetectMimeType.mockReturnValue("video/mp4");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x00, 0x00, 0x00, 0x18])} mediaType="video" />
      );
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.className).toContain("bg-black");
    });

    it("article media renders with a transparent container", () => {
      // Text sits on the page background; a black tile around prose looks
      // heavy. Article body bytes go through the HTML fallback elsewhere;
      // this test pins just the container styling.
      mockDetectMimeType.mockReturnValue("text/html");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x23, 0x20, 0x48])} mediaType="article" />
      );
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.className).not.toContain("bg-black");
    });

    it("keeps the blob URL alive across onload so the lightbox click handler can reuse it", () => {
      // We deliberately moved revoke from `img.onload` to component cleanup
      // so clicking the rendered image to open the full-resolution lightbox
      // doesn't hit a dead blob URL.
      mockDetectMimeType.mockReturnValue("image/png");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x89, 0x50, 0x4e, 0x47])} mediaType="image" />
      );
      const img = container.querySelector("img");
      act(() => {
        img?.dispatchEvent(new Event("load"));
      });
      // `onload` must NOT revoke — that's what the lightbox needs.
      expect(global.URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    it("revokes the image blob URL when the component unmounts", () => {
      mockDetectMimeType.mockReturnValue("image/png");

      const { unmount } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x89, 0x50, 0x4e, 0x47])} mediaType="image" />
      );
      expect(global.URL.revokeObjectURL).not.toHaveBeenCalled();
      unmount();
      expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
    });

    it("handles image onerror by reporting to Sentry (without revoking — cleanup handles that)", () => {
      mockDetectMimeType.mockReturnValue("image/jpeg");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0xff, 0xd8, 0xff])} mediaType="image" />
      );
      const img = container.querySelector("img");
      act(() => {
        img?.dispatchEvent(new Event("error"));
      });
      expect(mockCaptureException).toHaveBeenCalled();
    });

    it("renders video for video/ mime type", () => {
      mockDetectMimeType.mockReturnValue("video/mp4");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x00, 0x00, 0x00])} mediaType="video" />
      );
      const video = container.querySelector("video");
      expect(video).toBeTruthy();
      expect(video?.controls).toBe(true);
    });

    it("handles video blob onerror by reporting to Sentry (cleanup handles revoke)", () => {
      mockDetectMimeType.mockReturnValue("video/webm");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x1a, 0x45, 0xdf])} mediaType="video" />
      );
      const video = container.querySelector("video");
      act(() => {
        video?.dispatchEvent(new Event("error"));
      });
      expect(mockCaptureException).toHaveBeenCalled();
    });

    it("renders audio for audio/ mime type", () => {
      mockDetectMimeType.mockReturnValue("audio/mpeg");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x49, 0x44, 0x33])} mediaType="audio" />
      );
      const audio = container.querySelector("audio");
      expect(audio).toBeTruthy();
      expect(audio?.controls).toBe(true);
    });

    it("handles audio blob onerror by reporting to Sentry (cleanup handles revoke)", () => {
      mockDetectMimeType.mockReturnValue("audio/mpeg");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x49, 0x44, 0x33])} mediaType="audio" />
      );
      const audio = container.querySelector("audio");
      act(() => {
        audio?.dispatchEvent(new Event("error"));
      });
      expect(mockCaptureException).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------
  // ContentRendererDOM — HTML fallback
  // -------------------------------------------------------
  describe("HTML content fallback", () => {
    it("renders sanitized HTML in shadow DOM", () => {
      mockDetectMimeType.mockReturnValue("text/html");

      const { container } = render(
        <ContentRenderer
          decryptedBytes={toBytes("<h1>Hello World</h1>")}
          mediaType="article"
        />
      );
      // The div should exist (shadow DOM won't be queryable from outside)
      const rendererDiv = container.querySelector("div.min-h-\\[200px\\]");
      expect(rendererDiv).toBeTruthy();
    });
  });

  // -------------------------------------------------------
  // Markdown article rendering
  // -------------------------------------------------------
  describe("markdown article rendering", () => {
    it("parses markdown when mediaType is article and content is not a URL", () => {
      mockDetectMimeType.mockReturnValue("text/html");
      const markdown = "# Title\n\nSome **bold** text.";

      render(
        <ContentRenderer
          decryptedBytes={toBytes(markdown)}
          mediaType="article"
        />
      );

      expect(mockMarkedParse).toHaveBeenCalledTimes(1);
      expect(mockMarkedParse).toHaveBeenCalledWith(markdown);
    });

    it("does not parse markdown for non-article mediaType when content is HTML", () => {
      mockDetectMimeType.mockReturnValue("text/html");

      render(
        <ContentRenderer
          decryptedBytes={toBytes("<p>raw html</p>")}
          mediaType="video"
        />
      );

      expect(mockMarkedParse).not.toHaveBeenCalled();
    });

    it("renders the existing link card for article URLs without invoking marked", () => {
      // URL articles take the text/url branch, not the markdown path
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://example.com/post");

      const { container } = render(
        <ContentRenderer
          decryptedBytes={toBytes("https://example.com/post")}
          mediaType="article"
        />
      );

      expect(mockMarkedParse).not.toHaveBeenCalled();
      // External link card includes an anchor with the article URL
      const link = container.querySelector('a[href="https://example.com/post"]');
      expect(link).toBeTruthy();
      expect(link?.getAttribute("target")).toBe("_blank");
    });
  });

  // -------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------
  describe("edge cases", () => {
    it("does not render content for empty bytes", () => {
      mockDetectMimeType.mockReturnValue("text/html");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array(0)} mediaType="video" />
      );
      // The container div should be empty because useEffect bails early
      const rendererDiv = container.querySelector("div.min-h-\\[200px\\]");
      expect(rendererDiv).toBeTruthy();
      expect(rendererDiv?.children.length).toBe(0);
    });

    it("handles toEmbedUrl with invalid URL gracefully", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("not-a-valid-url");

      // isEmbedUrl returns false for invalid URLs, isDirectMediaUrl also false
      // So it falls to the "unknown URL" iframe branch
      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("x")} mediaType="other" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
    });

    it("renders iframe onerror handler for embed URLs", () => {
      mockDetectMimeType.mockReturnValue("text/url");
      mockBytesToUrl.mockReturnValue("https://www.youtube.com/watch?v=test");

      const { container } = render(
        <ContentRenderer decryptedBytes={toBytes("url")} mediaType="video" />
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();

      act(() => {
        iframe?.dispatchEvent(new Event("error"));
      });
      expect(mockCaptureException).toHaveBeenCalled();
    });
  });
});
