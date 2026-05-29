// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/i18n", () => ({
  t: (_locale: string, key: string) => key,
}));

import UnavailableWall from "@/components/UnavailableWall";

describe("UnavailableWall", () => {
  describe("card variant", () => {
    it("renders the not available heading", () => {
      render(<UnavailableWall variant="card" mediaName="Test" locale="en" />);
      expect(screen.getByText("viewer.media.not_available")).toBeInTheDocument();
    });

    it("renders the description", () => {
      render(<UnavailableWall variant="card" mediaName="Test" locale="en" />);
      expect(screen.getByText("viewer.media.not_available_description")).toBeInTheDocument();
    });

    it("renders a lock icon", () => {
      const { container } = render(<UnavailableWall variant="card" mediaName="Test" locale="en" />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg?.getAttribute("width")).toBe("22");
    });
  });

  describe("overlay variant with thumbnail", () => {
    it("renders the thumbnail image", () => {
      render(<UnavailableWall variant="overlay" thumbnailUrl="/thumb.jpg" mediaName="My Media" locale="en" />);
      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", "/thumb.jpg");
      expect(img).toHaveAttribute("alt", "My Media");
    });

    it("renders the image with reduced opacity", () => {
      render(<UnavailableWall variant="overlay" thumbnailUrl="/thumb.jpg" mediaName="My Media" locale="en" />);
      const img = screen.getByRole("img");
      expect(img.className).toContain("opacity-30");
    });

    it("shows the not available text overlay", () => {
      render(<UnavailableWall variant="overlay" thumbnailUrl="/thumb.jpg" mediaName="My Media" locale="en" />);
      expect(screen.getByText("viewer.media.not_available")).toBeInTheDocument();
    });

    it("renders a lock icon in a chip", () => {
      const { container } = render(<UnavailableWall variant="overlay" thumbnailUrl="/thumb.jpg" mediaName="My Media" locale="en" />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("width")).toBe("22");
    });
  });

  describe("overlay variant without thumbnail", () => {
    it("renders placeholder without an image", () => {
      render(<UnavailableWall variant="overlay" mediaName="My Media" locale="en" />);
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("shows the not available text", () => {
      render(<UnavailableWall variant="overlay" mediaName="My Media" locale="en" />);
      expect(screen.getByText("viewer.media.not_available")).toBeInTheDocument();
    });

    it("renders a lock icon", () => {
      const { container } = render(<UnavailableWall variant="overlay" mediaName="My Media" locale="en" />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg?.getAttribute("width")).toBe("22");
    });
  });
});
