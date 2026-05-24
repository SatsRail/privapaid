// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/i18n/useLocale", () => ({
  useLocale: () => ({
    t: (key: string) => key,
    locale: "en",
  }),
}));

import ExpandableDescription from "@/components/ExpandableDescription";

describe("ExpandableDescription", () => {
  it("renders the description text", () => {
    render(<ExpandableDescription text="A short description." />);
    expect(screen.getByText("A short description.")).toBeInTheDocument();
  });

  it("does NOT show the expand toggle when content fits in the collapsed budget", async () => {
    // jsdom doesn't do real layout, so scrollHeight === clientHeight for any
    // text — short text never needs the toggle. We assert the absence.
    render(<ExpandableDescription text="Tiny." />);
    // Wait for the requestAnimationFrame effect to run.
    await waitFor(() => {
      expect(screen.queryByTestId("description-toggle")).not.toBeInTheDocument();
    });
  });

  it("shows the expand toggle when text overflows (scrollHeight > clientHeight)", async () => {
    // Force the overflow signal by stubbing scrollHeight/clientHeight on the
    // <p> element. jsdom gives both as 0 by default.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() { return 200; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return 40; },
    });

    render(<ExpandableDescription text="Long enough to overflow at 2 lines under any reasonable font size." />);
    await waitFor(() => {
      expect(screen.getByTestId("description-toggle")).toBeInTheDocument();
    });
    expect(screen.getByTestId("description-toggle")).toHaveTextContent("viewer.description.show_more");
  });

  it("toggles between collapsed and expanded on click", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() { return 200; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return 40; },
    });

    render(<ExpandableDescription text="Very long content." />);
    await waitFor(() => {
      expect(screen.getByTestId("description-toggle")).toBeInTheDocument();
    });

    const btn = screen.getByTestId("description-toggle");
    expect(btn).toHaveTextContent("viewer.description.show_more");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("viewer.description.show_less");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("viewer.description.show_more");
  });
});
