// @vitest-environment jsdom
//
// End-to-end tests for the markdown article render path using the *real*
// `marked` and `DOMPurify` modules. The companion file ContentRenderer.test.tsx
// mocks both for fast wiring tests; this file proves the actual sanitization
// + conversion behavior that the closed-shadow-DOM contract relies on.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import DOMPurify from "dompurify";

vi.mock("@/lib/client-crypto", () => ({
  // Markdown bytes never start with http(s)://, so detectMimeType returns "text/html"
  detectMimeType: () => "text/html",
  bytesToUrl: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/components/PhotoGallery", () => ({
  default: () => null,
}));

import ContentRenderer from "@/components/ContentRenderer";

function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

describe("ContentRenderer markdown path (real marked + DOMPurify)", () => {
  let sanitizeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sanitizeSpy = vi.spyOn(DOMPurify, "sanitize");
  });

  afterEach(() => {
    sanitizeSpy.mockRestore();
  });

  function lastSanitizeCall() {
    const calls = sanitizeSpy.mock.calls;
    const results = sanitizeSpy.mock.results;
    return {
      input: calls[calls.length - 1][0] as string,
      output: results[results.length - 1].value as string,
    };
  }

  it("converts markdown to HTML before sanitization", () => {
    render(
      <ContentRenderer
        decryptedBytes={toBytes("# Title\n\nA **bold** paragraph.\n\n- item 1\n- item 2")}
        mediaType="article"
      />
    );

    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
    const { output } = lastSanitizeCall();
    expect(output).toContain("<h1");
    expect(output).toContain("Title");
    expect(output).toContain("<strong>bold</strong>");
    expect(output).toContain("<ul>");
    expect(output).toContain("<li>item 1</li>");
  });

  it("renders GFM features (fenced code, tables)", () => {
    const md = [
      "```js",
      "console.log('hi');",
      "```",
      "",
      "| col1 | col2 |",
      "| ---- | ---- |",
      "| a    | b    |",
    ].join("\n");

    render(<ContentRenderer decryptedBytes={toBytes(md)} mediaType="article" />);

    const { output } = lastSanitizeCall();
    expect(output).toContain("<pre>");
    expect(output).toContain("console.log");
    expect(output).toContain("<table>");
    expect(output).toContain("<th>col1</th>");
    expect(output).toContain("<td>a</td>");
  });

  it("strips <script> tags embedded in markdown content", () => {
    const malicious = "# Safe heading\n\n<script>alert('xss')</script>\n\nAfter script.";
    render(
      <ContentRenderer decryptedBytes={toBytes(malicious)} mediaType="article" />
    );

    const { input, output } = lastSanitizeCall();
    // marked itself preserves the script tag — DOMPurify must remove it
    expect(input).toContain("<script>");
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("alert(");
    // Legitimate content survives
    expect(output).toContain("Safe heading");
    expect(output).toContain("After script.");
  });

  it("strips inline event handlers like onerror from markdown HTML", () => {
    const malicious = '# Heading\n\n<img src=x onerror="alert(1)">';
    render(
      <ContentRenderer decryptedBytes={toBytes(malicious)} mediaType="article" />
    );

    const { output } = lastSanitizeCall();
    expect(output).not.toContain("onerror");
    expect(output).not.toContain("alert(1)");
  });

  it("strips javascript: URLs in markdown links", () => {
    const malicious = "[click me](javascript:alert(1))";
    render(
      <ContentRenderer decryptedBytes={toBytes(malicious)} mediaType="article" />
    );

    const { output } = lastSanitizeCall();
    expect(output.toLowerCase()).not.toContain("javascript:");
  });
});
