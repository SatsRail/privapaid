// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/i18n/useLocale", () => ({
  useLocale: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

import AboutModal from "@/components/AboutModal";

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  aboutText: "This is a test about text",
  instanceName: "Test Instance",
};

describe("AboutModal", () => {
  it("returns null when not open", () => {
    const { container } = render(
      <AboutModal {...defaultProps} open={false} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders when open", () => {
    render(<AboutModal {...defaultProps} />);
    expect(screen.getByText("viewer.navbar.about")).toBeInTheDocument();
    expect(screen.getByText("Test Instance")).toBeInTheDocument();
    expect(screen.getByText("This is a test about text")).toBeInTheDocument();
  });

  it("renders em dash when aboutText is empty", () => {
    render(<AboutModal {...defaultProps} aboutText="" />);
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    render(<AboutModal {...defaultProps} onClose={onClose} />);
    // There are two close buttons: the X and the Cancel button
    const cancelBtn = screen.getByText("common.cancel");
    fireEvent.click(cancelBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when X button clicked", () => {
    const onClose = vi.fn();
    render(<AboutModal {...defaultProps} onClose={onClose} />);
    const buttons = screen.getAllByRole("button");
    // First button is the X close button
    fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key pressed", () => {
    const onClose = vi.fn();
    render(<AboutModal {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not register keydown when closed", () => {
    const onClose = vi.fn();
    render(<AboutModal {...defaultProps} open={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when backdrop clicked", () => {
    const onClose = vi.fn();
    render(<AboutModal {...defaultProps} onClose={onClose} />);
    // The backdrop is the outermost fixed div. Modal dismisses on mousedown
    // (not click) so a drag-select that releases outside the dialog doesn't
    // accidentally close it.
    const backdrop = document.querySelector(".fixed.inset-0") as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when inner content clicked", () => {
    const onClose = vi.fn();
    render(<AboutModal {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Test Instance"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
