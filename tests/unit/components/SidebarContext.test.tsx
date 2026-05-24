// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarProvider, useSidebar } from "@/components/SidebarContext";

function TestConsumer() {
  const { collapsed, toggle } = useSidebar();
  return (
    <div>
      <span data-testid="collapsed">{String(collapsed)}</span>
      <button data-testid="toggle" onClick={toggle}>Toggle</button>
    </div>
  );
}

const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
};

describe("SidebarContext", () => {
  beforeEach(() => {
    for (const k in store) delete store[k];
    vi.clearAllMocks();
    Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
    Object.defineProperty(window, "localStorage", { value: mockLocalStorage, writable: true, configurable: true });
  });

  it("defaults to collapsed on desktop with no localStorage", () => {
    render(
      <SidebarProvider><TestConsumer /></SidebarProvider>
    );
    expect(screen.getByTestId("collapsed")).toHaveTextContent("true");
  });

  it("defaults to collapsed on mobile", () => {
    Object.defineProperty(window, "innerWidth", { value: 768, writable: true, configurable: true });
    render(
      <SidebarProvider><TestConsumer /></SidebarProvider>
    );
    expect(screen.getByTestId("collapsed")).toHaveTextContent("true");
  });

  it("respects localStorage false (user opened sidebar)", () => {
    store["sidebar-collapsed"] = "false";
    render(
      <SidebarProvider><TestConsumer /></SidebarProvider>
    );
    expect(screen.getByTestId("collapsed")).toHaveTextContent("false");
  });

  it("respects localStorage true (user collapsed sidebar)", () => {
    store["sidebar-collapsed"] = "true";
    render(
      <SidebarProvider><TestConsumer /></SidebarProvider>
    );
    expect(screen.getByTestId("collapsed")).toHaveTextContent("true");
  });

  it("toggles collapsed state and persists to localStorage", async () => {
    const user = userEvent.setup();
    render(
      <SidebarProvider><TestConsumer /></SidebarProvider>
    );

    expect(screen.getByTestId("collapsed")).toHaveTextContent("true");

    await user.click(screen.getByTestId("toggle"));
    expect(screen.getByTestId("collapsed")).toHaveTextContent("false");
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith("sidebar-collapsed", "false");

    await user.click(screen.getByTestId("toggle"));
    expect(screen.getByTestId("collapsed")).toHaveTextContent("true");
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith("sidebar-collapsed", "true");
  });

  it("honors localStorage on mobile too — the sidebar is now an overlay drawer at every breakpoint", () => {
    // Architectural shift: the sidebar is no longer a 72px icon rail on
    // desktop and a slide-out on mobile. It's now a full slide-out drawer
    // everywhere, so the previous "force-collapse on mobile" guard is
    // gone — the user's explicit choice wins, regardless of viewport.
    Object.defineProperty(window, "innerWidth", { value: 500, writable: true, configurable: true });
    store["sidebar-collapsed"] = "false";
    render(
      <SidebarProvider><TestConsumer /></SidebarProvider>
    );
    expect(screen.getByTestId("collapsed")).toHaveTextContent("false");
  });
});
