// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

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

vi.mock("@/components/PhotoGallery", () => ({
  default: ({ images }: { images: Array<{ url: string; caption?: string }> }) => (
    <div data-testid="photo-gallery">{images.length} images</div>
  ),
}));

vi.mock("dompurify", () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

const mockMarkedParse = vi.fn((text: string) => `<MD>${text}</MD>`);
vi.mock("marked", () => ({
  marked: {
    parse: (...args: unknown[]) => mockMarkedParse(...(args as [string])),
  },
}));

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
  // Photo set branch
  // -------------------------------------------------------
  describe("photo_set mediaType", () => {
    it("renders PhotoGallery for valid photo_set manifest", () => {
      const manifest = JSON.stringify({
        type: "photo_set",
        images: [
          { url: "https://example.com/1.jpg", caption: "First" },
          { url: "https://example.com/2.jpg" },
        ],
      });
      render(
        <ContentRenderer decryptedBytes={toBytes(manifest)} mediaType="photo_set" />
      );
      expect(screen.getByTestId("photo-gallery")).toBeInTheDocument();
      expect(screen.getByText("2 images")).toBeInTheDocument();
    });

    it("filters out invalid images in manifest", () => {
      const manifest = JSON.stringify({
        type: "photo_set",
        images: [
          { url: "https://example.com/1.jpg" },
          null,
          "not-an-object",
          { noUrl: true },
        ],
      });
      render(
        <ContentRenderer decryptedBytes={toBytes(manifest)} mediaType="photo_set" />
      );
      expect(screen.getByTestId("photo-gallery")).toBeInTheDocument();
      expect(screen.getByText("1 images")).toBeInTheDocument();
    });

    it("falls back to DOM renderer for invalid JSON manifest", () => {
      mockDetectMimeType.mockReturnValue("text/html");
      render(
        <ContentRenderer decryptedBytes={toBytes("not json")} mediaType="photo_set" />
      );
      // Should render the DOM-based container div instead of gallery
      expect(screen.queryByTestId("photo-gallery")).not.toBeInTheDocument();
    });

    it("falls back to DOM renderer when type is not photo_set in JSON", () => {
      const manifest = JSON.stringify({ type: "other", images: [] });
      mockDetectMimeType.mockReturnValue("text/html");
      render(
        <ContentRenderer decryptedBytes={toBytes(manifest)} mediaType="photo_set" />
      );
      expect(screen.queryByTestId("photo-gallery")).not.toBeInTheDocument();
    });

    it("falls back to DOM renderer when images array is empty", () => {
      const manifest = JSON.stringify({ type: "photo_set", images: [] });
      mockDetectMimeType.mockReturnValue("text/html");
      render(
        <ContentRenderer decryptedBytes={toBytes(manifest)} mediaType="photo_set" />
      );
      expect(screen.queryByTestId("photo-gallery")).not.toBeInTheDocument();
    });
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

    it("handles image onload by revoking object URL", () => {
      mockDetectMimeType.mockReturnValue("image/png");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x89, 0x50, 0x4e, 0x47])} mediaType="image" />
      );
      const img = container.querySelector("img");
      act(() => {
        img?.dispatchEvent(new Event("load"));
      });
      expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
    });

    it("handles image onerror", () => {
      mockDetectMimeType.mockReturnValue("image/jpeg");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0xff, 0xd8, 0xff])} mediaType="image" />
      );
      const img = container.querySelector("img");
      act(() => {
        img?.dispatchEvent(new Event("error"));
      });
      expect(global.URL.revokeObjectURL).toHaveBeenCalled();
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

    it("handles video blob onerror", () => {
      mockDetectMimeType.mockReturnValue("video/webm");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x1a, 0x45, 0xdf])} mediaType="video" />
      );
      const video = container.querySelector("video");
      act(() => {
        video?.dispatchEvent(new Event("error"));
      });
      expect(global.URL.revokeObjectURL).toHaveBeenCalled();
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

    it("handles audio blob onerror", () => {
      mockDetectMimeType.mockReturnValue("audio/mpeg");

      const { container } = render(
        <ContentRenderer decryptedBytes={new Uint8Array([0x49, 0x44, 0x33])} mediaType="audio" />
      );
      const audio = container.querySelector("audio");
      act(() => {
        audio?.dispatchEvent(new Event("error"));
      });
      expect(global.URL.revokeObjectURL).toHaveBeenCalled();
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
      expect(mockMarkedParse).toHaveBeenCalledWith(markdown, expect.objectContaining({
        async: false,
        gfm: true,
        breaks: true,
      }));
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

    it("skips photo_set parsing for non photo_set mediaType", () => {
      // Even if the bytes are valid JSON, if mediaType isn't photo_set, it should not parse
      const manifest = JSON.stringify({ type: "photo_set", images: [{ url: "a.jpg" }] });
      mockDetectMimeType.mockReturnValue("text/html");

      render(
        <ContentRenderer decryptedBytes={toBytes(manifest)} mediaType="video" />
      );
      expect(screen.queryByTestId("photo-gallery")).not.toBeInTheDocument();
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
