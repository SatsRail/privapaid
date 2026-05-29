// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/i18n/useLocale", () => ({
  useLocale: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

import AgeGate from "@/components/AgeGate";

beforeEach(() => {
  sessionStorage.clear();
});

describe("AgeGate", () => {
  it("renders the age gate overlay", () => {
    render(<AgeGate />);
    expect(screen.getByText("viewer.age_gate.title")).toBeInTheDocument();
    expect(screen.getByText("viewer.age_gate.default_message")).toBeInTheDocument();
    expect(screen.getByText("viewer.age_gate.confirm")).toBeInTheDocument();
    expect(screen.getByText("viewer.age_gate.deny")).toBeInTheDocument();
  });

  it("renders custom disclaimer text", () => {
    render(<AgeGate disclaimer="You must be 18+" />);
    expect(screen.getByText("You must be 18+")).toBeInTheDocument();
    expect(screen.queryByText("viewer.age_gate.default_message")).not.toBeInTheDocument();
  });

  it("hides after confirm button clicked", () => {
    const { container } = render(<AgeGate />);
    fireEvent.click(screen.getByText("viewer.age_gate.confirm"));
    // After confirming, component returns null
    expect(container.querySelector("[style*='position: fixed']")).toBeNull();
  });

  it("sets sessionStorage on confirm", () => {
    render(<AgeGate />);
    fireEvent.click(screen.getByText("viewer.age_gate.confirm"));
    expect(sessionStorage.getItem("privapaid_age_verified")).toBe("true");
  });

  it("redirects to google.com on deny", () => {
    // Mock window.location
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...originalLocation, href: "" },
    });

    render(<AgeGate />);
    fireEvent.click(screen.getByText("viewer.age_gate.deny"));
    expect(window.location.href).toBe("https://google.com");

    // Restore
    Object.defineProperty(window, "location", {
      writable: true,
      value: originalLocation,
    });
  });

  it("returns null when already verified in sessionStorage", () => {
    sessionStorage.setItem("privapaid_age_verified", "true");
    const { container } = render(<AgeGate />);
    expect(container.innerHTML).toBe("");
  });

  it("exposes a labelled modal dialog", () => {
    render(<AgeGate />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(screen.getByText("viewer.age_gate.title").id).toBe(labelId);
  });

  it("does not dismiss on Escape — the gate must be answered", () => {
    render(<AgeGate />);
    fireEvent.keyDown(document, { key: "Escape" });
    // Still showing: Escape cannot bypass the age gate.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("viewer.age_gate.confirm")).toBeInTheDocument();
  });
});
