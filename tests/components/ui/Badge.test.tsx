// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Badge from "@/components/ui/Badge";

describe("Badge", () => {
  it("renders with children text", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("uses a token-driven neutral by default", () => {
    render(<Badge>Default</Badge>);
    expect(screen.getByText("Default").className).toContain(
      "bg-[var(--theme-bg-secondary)]",
    );
  });

  it("applies green color", () => {
    render(<Badge color="green">Success</Badge>);
    expect(screen.getByText("Success").className).toContain("bg-green-500/15");
  });

  it("applies red color", () => {
    render(<Badge color="red">Error</Badge>);
    expect(screen.getByText("Error").className).toContain("bg-red-500/15");
  });

  it("applies yellow color", () => {
    render(<Badge color="yellow">Warning</Badge>);
    expect(screen.getByText("Warning").className).toContain("bg-yellow-500/20");
  });

  it("never emits dark: variants — they would clash with the light admin surface", () => {
    // `<html>` carries a permanent `.dark` class app-wide, so any dark: variant
    // would fire on the light admin too. Tints must be surface-independent.
    (["green", "red", "yellow", "blue", "pink", "zinc"] as const).forEach((c) => {
      const { unmount } = render(<Badge color={c}>{c}</Badge>);
      expect(screen.getByText(c).className).not.toContain("dark:");
      unmount();
    });
  });

  it("applies custom className", () => {
    render(<Badge className="extra-class">Custom</Badge>);
    expect(screen.getByText("Custom").className).toContain("extra-class");
  });

  it("renders as a span element", () => {
    const { container } = render(<Badge>Test</Badge>);
    expect(container.querySelector("span")).toBeInTheDocument();
  });
});
