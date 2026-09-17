// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CategoryChips from "@/components/CategoryChips";

const categories = [
  { _id: "cat1", name: "Music" },
  { _id: "cat2", name: "Art" },
];

describe("CategoryChips", () => {
  it("renders All button and category buttons", () => {
    render(<CategoryChips categories={categories} activeCategory={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "All content", pressed: true })).toBeInTheDocument();
    expect(screen.getByText("Music")).toBeInTheDocument();
    expect(screen.getByText("Art")).toBeInTheDocument();
  });

  it("calls onSelect with null when All is clicked", () => {
    const onSelect = vi.fn();
    render(<CategoryChips categories={categories} activeCategory="cat1" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("All content"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("calls onSelect with category id when category is clicked", () => {
    const onSelect = vi.fn();
    render(<CategoryChips categories={categories} activeCategory={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Music"));
    expect(onSelect).toHaveBeenCalledWith("cat1");
  });

  it("applies active style to All when activeCategory is null", () => {
    render(<CategoryChips categories={categories} activeCategory={null} onSelect={vi.fn()} />);
    const allBtn = screen.getByText("All content");
    expect(allBtn.className).toContain("bg-white");
    expect(allBtn.className).toContain("text-black");
  });

  it("applies active style to selected category", () => {
    render(<CategoryChips categories={categories} activeCategory="cat2" onSelect={vi.fn()} />);
    const artBtn = screen.getByText("Art");
    expect(artBtn.className).toContain("bg-white");
    expect(artBtn.className).toContain("text-black");
    // All button should not be active
    const allBtn = screen.getByText("All content");
    expect(allBtn.className).not.toContain("bg-white text-black");
  });

  it("renders with empty categories", () => {
    render(<CategoryChips categories={[]} activeCategory={null} onSelect={vi.fn()} />);
    expect(screen.getByText("All content")).toBeInTheDocument();
  });
});
