// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useState } from "react";

// Mock MediaForm dependencies so importing the module doesn't pull in heavy infra.
// ArticleContentField itself has no external dependencies — these mocks just keep
// the module importable.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));
vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }));
vi.mock("@/components/ui/Button", () => ({ default: () => null }));
vi.mock("@/components/ui/Input", () => ({ default: () => null }));
vi.mock("@/components/ui/Select", () => ({ default: () => null }));
vi.mock("@/components/ui/Modal", () => ({ default: () => null }));
vi.mock("@/components/ui/ImageUpload", () => ({ default: () => null }));

import {
  ArticleContentField,
  ARTICLE_MAX_BYTES,
} from "@/app/admin/channels/[id]/media/MediaForm";

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ArticleContentField value={value} onChange={setValue} />
      <div data-testid="current-value">{value}</div>
    </>
  );
}

function makeFile(name: string, content: string, type = "text/markdown"): File {
  return new File([content], name, { type });
}

describe("ArticleContentField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an editable textarea with the current value", () => {
    render(<Harness initial="# Hello" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Hello");
  });

  it("updates the value when the textarea changes", () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "## Edited" } });
    expect(screen.getByTestId("current-value")).toHaveTextContent("## Edited");
  });

  it("populates the textarea from an uploaded .md file", async () => {
    const { container } = render(<Harness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    expect(fileInput.accept).toContain(".md");

    const file = makeFile("article.md", "# From file\n\nBody.");
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    expect(screen.getByTestId("current-value")).toHaveTextContent("# From file Body.");
  });

  it("rejects files larger than ARTICLE_MAX_BYTES and surfaces an error", async () => {
    const { container } = render(<Harness initial="original" />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    const oversized = makeFile("big.md", "x".repeat(ARTICLE_MAX_BYTES + 1));
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [oversized] } });
    });

    expect(screen.getByText(/File too large/i)).toBeInTheDocument();
    // Original value preserved
    expect(screen.getByTestId("current-value")).toHaveTextContent("original");
  });

  it("shows the URL-detection hint when the value is an http URL", () => {
    render(<Harness initial="https://example.com/article" />);
    expect(
      screen.getByText(/URL detected — will render as an external link card\./i)
    ).toBeInTheDocument();
  });

  it("shows the markdown hint when the value is not a URL", () => {
    render(<Harness initial="# Heading" />);
    expect(
      screen.getByText(/Markdown — renders inline after payment\./i)
    ).toBeInTheDocument();
  });

  it("displays a live byte counter that turns red when over the cap", () => {
    const overByOne = "a".repeat(ARTICLE_MAX_BYTES + 1);
    render(<Harness initial={overByOne} />);
    // 500.0KB+ display
    const counter = screen.getByText(/KB \/ 500KB/);
    expect(counter).toBeInTheDocument();
    expect(counter.className).toContain("text-red");
  });
});
