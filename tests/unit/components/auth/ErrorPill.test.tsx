// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ErrorPill from "@/components/auth/ErrorPill";

describe("ErrorPill", () => {
  it("renders the error message", () => {
    render(<ErrorPill message="Invalid email" />);
    expect(screen.getByText("Invalid email")).toBeInTheDocument();
  });

  it("renders an SVG icon", () => {
    const { container } = render(<ErrorPill message="Oops" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("uses default theme colors when no theme provided", () => {
    render(<ErrorPill message="Error" />);
    const span = screen.getByText("Error");
    expect(span.style.color).toBe("rgb(248, 113, 113)"); // #f87171
  });

  it("uses custom theme colors when provided", () => {
    const customTheme = {
      color: {
        bg: "#000",
        card: "#111",
        accent: "#ff0000",
        accentLight: "#ff3333",
        accentGlow: "rgba(255,0,0,0.1)",
        white: "#fff",
        gray100: "#f0f0f0",
        gray300: "#b8b8b8",
        gray500: "#808080",
        gray700: "#222222",
        red: "#ee0000",
        green: "#00ee00",
        border: "rgba(255,255,255,0.06)",
      },
      font: {
        display: "'Custom', sans-serif",
        body: "'CustomBody', sans-serif",
      },
    };
    render(<ErrorPill message="Themed error" theme={customTheme} />);
    const span = screen.getByText("Themed error");
    expect(span.style.fontFamily).toContain("CustomBody");
  });
});
