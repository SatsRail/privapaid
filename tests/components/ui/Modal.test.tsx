// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Modal from "@/components/ui/Modal";

describe("Modal", () => {
  it("renders when open", () => {
    render(
      <Modal open onClose={vi.fn()}>
        <p>Modal content</p>
      </Modal>
    );
    expect(screen.getByText("Modal content")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(
      <Modal open={false} onClose={vi.fn()}>
        <p>Modal content</p>
      </Modal>
    );
    expect(screen.queryByText("Modal content")).not.toBeInTheDocument();
  });

  it("renders title when provided", () => {
    render(
      <Modal open onClose={vi.fn()} title="My Dialog">
        <p>Content</p>
      </Modal>
    );
    expect(screen.getByText("My Dialog")).toBeInTheDocument();
  });

  it("has dialog role and aria-modal", () => {
    render(
      <Modal open onClose={vi.fn()} title="Test">
        <p>Content</p>
      </Modal>
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Test">
        <p>Content</p>
      </Modal>
    );
    await userEvent.click(screen.getByLabelText("Close dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <p>Content</p>
      </Modal>
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking the overlay backdrop", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <p>Content</p>
      </Modal>
    );
    // The overlay is the outermost fixed div
    const overlay = screen.getByRole("dialog").parentElement!;
    // mouseDown on the overlay itself (not the dialog)
    await userEvent.pointer({ keys: "[MouseLeft>]", target: overlay });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the dialog", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <p>Content</p>
      </Modal>
    );
    await userEvent.click(screen.getByText("Content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("traps focus with Tab: wraps from last to first focusable element", async () => {
    render(
      <Modal open onClose={vi.fn()} title="Trap">
        <button>First</button>
        <button>Last</button>
      </Modal>
    );

    // Wait for the requestAnimationFrame focus
    await vi.waitFor(() => {
      // The close button or first button should be focused
      expect(document.activeElement).not.toBe(document.body);
    });

    const lastButton = screen.getByText("Last");
    lastButton.focus();
    expect(document.activeElement).toBe(lastButton);

    // Tab from the last focusable element should wrap to the first
    await userEvent.keyboard("{Tab}");

    // After wrap, focus should be on the close button (first focusable in dialog)
    const closeButton = screen.getByLabelText("Close dialog");
    expect(document.activeElement).toBe(closeButton);
  });

  it("traps focus with Shift+Tab: wraps from first to last focusable element", async () => {
    render(
      <Modal open onClose={vi.fn()} title="Trap">
        <button>First</button>
        <button>Last</button>
      </Modal>
    );

    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
    });

    // Focus the close button (first focusable in dialog)
    const closeButton = screen.getByLabelText("Close dialog");
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);

    // Shift+Tab from the first focusable should wrap to last
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");

    const lastButton = screen.getByText("Last");
    expect(document.activeElement).toBe(lastButton);
  });

  it("focuses the dialog itself when no focusable children exist", async () => {
    render(
      <Modal open onClose={vi.fn()}>
        <p>No focusable elements here</p>
      </Modal>
    );

    // Wait for requestAnimationFrame
    await vi.waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(document.activeElement).toBe(dialog);
    });
  });

  it("locks body scroll when open and restores on close", () => {
    const { rerender } = render(
      <Modal open onClose={vi.fn()}>
        <p>Content</p>
      </Modal>
    );
    expect(document.body.style.overflow).toBe("hidden");

    rerender(
      <Modal open={false} onClose={vi.fn()}>
        <p>Content</p>
      </Modal>
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("does not render close button when title is omitted", () => {
    render(
      <Modal open onClose={vi.fn()}>
        <p>Content</p>
      </Modal>
    );
    expect(screen.queryByLabelText("Close dialog")).not.toBeInTheDocument();
  });

  it("sets aria-labelledby when title is provided", () => {
    render(
      <Modal open onClose={vi.fn()} title="Labeled">
        <p>Content</p>
      </Modal>
    );
    const dialog = screen.getByRole("dialog");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const heading = screen.getByText("Labeled");
    expect(heading.id).toBe(labelId);
  });

  it("does not set aria-labelledby when title is omitted", () => {
    render(
      <Modal open onClose={vi.fn()}>
        <p>Content</p>
      </Modal>
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeNull();
  });

  it("handles Tab key when no focusable children exist (early return)", async () => {
    render(
      <Modal open onClose={vi.fn()}>
        <p>No buttons here</p>
      </Modal>
    );

    // Wait for initial focus to settle on the dialog itself
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("dialog"));
    });

    // Dispatch Tab directly -- should not throw, just early return
    fireEvent.keyDown(document, { key: "Tab" });

    // Dialog should still be focused (no crash, no change)
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("restores focus to trigger element when modal closes", async () => {
    // Create a trigger button and focus it before opening the modal
    const Wrapper = () => {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button data-testid="trigger" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} onClose={() => setOpen(false)}>
            <button>Inside</button>
          </Modal>
        </>
      );
    };

    render(<Wrapper />);
    const trigger = screen.getByTestId("trigger");

    // Focus and click the trigger to open
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);

    // Modal should be open and focus moved inside
    await vi.waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Press Escape to close the modal
    await userEvent.keyboard("{Escape}");

    // Focus should be restored to the trigger button
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("does not wrap focus on Tab when active element is in the middle", async () => {
    render(
      <Modal open onClose={vi.fn()} title="Trap">
        <button>First</button>
        <button>Middle</button>
        <button>Last</button>
      </Modal>
    );

    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
    });

    // Focus the middle button
    const middleButton = screen.getByText("Middle");
    middleButton.focus();
    expect(document.activeElement).toBe(middleButton);

    // Tab from the middle should NOT wrap (handler allows default)
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    const prevented = !document.dispatchEvent(event);
    // preventDefault should NOT have been called since we're in the middle
    expect(prevented).toBe(false);
  });
});
