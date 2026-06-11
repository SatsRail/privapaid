// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PreviewGallery from "@/components/PreviewGallery";

describe("PreviewGallery", () => {
  it("returns null when images array is empty", () => {
    const { container } = render(<PreviewGallery images={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders image tiles", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} />);
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(3);
    expect(images[0]).toHaveAttribute("alt", "Preview 1");
    expect(images[1]).toHaveAttribute("alt", "Preview 2");
    expect(images[2]).toHaveAttribute("alt", "Preview 3");
  });

  it("uses 2-column grid for 2 or fewer images", () => {
    const { container } = render(<PreviewGallery images={["/a.jpg", "/b.jpg"]} />);
    const grid = container.querySelector(".grid");
    expect(grid?.className).toContain("grid-cols-2");
  });

  it("uses 3-column grid for 3+ images", () => {
    const { container } = render(<PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} />);
    const grid = container.querySelector(".grid");
    expect(grid?.className).toContain("grid-cols-3");
  });

  it("opens lightbox when image tile is clicked", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    // Lightbox should now be visible with close button
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
  });

  it("shows counter in lightbox for multiple images", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[1]); // Open second image

    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("does not show counter for single image", () => {
    render(<PreviewGallery images={["/a.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(screen.queryByText("1 / 1")).toBeNull();
  });

  it("shows nav buttons for multiple images", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(screen.getByLabelText("Previous")).toBeInTheDocument();
    expect(screen.getByLabelText("Next")).toBeInTheDocument();
  });

  it("does not show nav buttons for single image", () => {
    render(<PreviewGallery images={["/a.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(screen.queryByLabelText("Previous")).toBeNull();
    expect(screen.queryByLabelText("Next")).toBeNull();
  });

  it("navigates to next image", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]); // Open first image

    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Next"));
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("navigates to previous image with wraparound", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]); // Open first image

    fireEvent.click(screen.getByLabelText("Previous"));
    expect(screen.getByText("3 / 3")).toBeInTheDocument(); // Wraps to last
  });

  it("wraps forward from last to first", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[1]); // Open second (last) image

    fireEvent.click(screen.getByLabelText("Next"));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("closes lightbox when close button clicked", () => {
    render(<PreviewGallery images={["/a.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(screen.getByLabelText("Close")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  it("closes lightbox when backdrop clicked", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    // Click the backdrop (the fixed overlay div)
    const backdrop = document.querySelector(".fixed.inset-0.z-50");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  it("handles Escape key to close lightbox", () => {
    render(<PreviewGallery images={["/a.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(screen.getByLabelText("Close")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  it("handles ArrowRight key for next image", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("handles ArrowLeft key for previous image", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[1]);

    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("locks body scroll when lightbox is open", () => {
    render(<PreviewGallery images={["/a.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(document.body.style.overflow).toBe("hidden");
  });

  it("restores body scroll when lightbox closes", () => {
    render(<PreviewGallery images={["/a.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByLabelText("Close"));
    expect(document.body.style.overflow).toBe("");
  });

  it("does not close lightbox when image container is clicked", () => {
    render(<PreviewGallery images={["/a.jpg", "/b.jpg"]} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    // The lightbox image container stops propagation so backdrop click
    // doesn't close it. Find the lightbox image (the one with object-contain class).
    const lightboxImgs = screen.getAllByAltText("Preview 1");
    const lightboxImg = lightboxImgs.find((img) =>
      img.className.includes("object-contain")
    );
    expect(lightboxImg).toBeDefined();
    const container = lightboxImg!.closest("div.flex");
    expect(container).not.toBeNull();
    fireEvent.click(container!);
    // Lightbox should still be open
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
  });

  describe("compact mode", () => {
    it("uses 5-column grid", () => {
      const { container } = render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const grid = container.querySelector(".grid");
      expect(grid?.className).toContain("grid-cols-5");
    });

    it("selects image on tile click and shows inline viewer", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]);

      // Inline viewer should show the selected image and counter
      expect(screen.getByAltText("Photo 1")).toBeInTheDocument();
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });

    it("deselects image when same tile is clicked again", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[1]); // select second
      expect(screen.getByAltText("Photo 2")).toBeInTheDocument();

      // Click the same tile again to deselect
      // Re-query because the DOM changed (nav buttons appeared)
      const allButtons = screen.getAllByRole("button");
      // Find the tile button for image 2 (the one whose img has alt "Preview 2")
      const tile = allButtons.find((b) =>
        b.querySelector('img[alt="Preview 2"]')
      );
      expect(tile).toBeDefined();
      fireEvent.click(tile!);

      // Inline viewer should be gone
      expect(screen.queryByAltText("Photo 2")).toBeNull();
    });

    it("navigates to next image with Next button", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]); // select first

      expect(screen.getByText("1 / 3")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Next"));
      expect(screen.getByText("2 / 3")).toBeInTheDocument();
    });

    it("navigates to previous image with Previous button", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[1]); // select second

      expect(screen.getByText("2 / 3")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Previous"));
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });

    it("wraps previous from first to last image", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]); // select first

      expect(screen.getByText("1 / 3")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Previous"));
      expect(screen.getByText("3 / 3")).toBeInTheDocument();
    });

    it("wraps next from last to first image", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[2]); // select last

      expect(screen.getByText("3 / 3")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Next"));
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });

    it("handles ArrowRight key to go next", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]);

      expect(screen.getByText("1 / 3")).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "ArrowRight" });
      expect(screen.getByText("2 / 3")).toBeInTheDocument();
    });

    it("handles ArrowLeft key to go previous", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[1]);

      expect(screen.getByText("2 / 3")).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "ArrowLeft" });
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });

    it("handles Escape key to deselect", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg", "/c.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]);

      expect(screen.getByAltText("Photo 1")).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByAltText("Photo 1")).toBeNull();
    });

    it("does not lock body scroll in compact mode", () => {
      document.body.style.overflow = "";
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]);

      expect(document.body.style.overflow).toBe("");
    });

    it("does not show lightbox in compact mode", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg"]} compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]);

      // No close button (lightbox indicator)
      expect(screen.queryByLabelText("Close")).toBeNull();
      // No fixed overlay
      expect(document.querySelector(".fixed.inset-0.z-50")).toBeNull();
    });
  });

  describe("locked mode", () => {
    it("does not open lightbox when locked and not compact", () => {
      render(<PreviewGallery images={["/a.jpg", "/b.jpg"]} locked />);
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]);

      expect(screen.queryByLabelText("Close")).toBeNull();
    });

    it("allows tile selection when locked and compact", () => {
      render(
        <PreviewGallery images={["/a.jpg", "/b.jpg"]} locked compact />
      );
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]);

      // Should still show inline viewer since compact overrides locked
      expect(screen.getByAltText("Photo 1")).toBeInTheDocument();
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });
  });
});
