"use client";

import { createContext, useContext, useState, useSyncExternalStore, useCallback } from "react";

interface SidebarContextValue {
  collapsed: boolean;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  collapsed: false,
  toggle: () => {},
});

function getClientCollapsed(): boolean {
  // YouTube watch-page model: rail hidden by default on every breakpoint.
  // The hamburger toggle reveals it as a slide-out overlay; localStorage
  // only sticks the explicit "open" choice so it survives navigation. A
  // freshly-loaded page is always collapsed.
  const stored = localStorage.getItem("sidebar-collapsed");
  if (stored === "false") return false; // user explicitly opened it
  return true;
}

// noop subscribe — we only need the snapshot for initial client value
const noop = () => () => {};

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const clientInitial = useSyncExternalStore(noop, getClientCollapsed, () => true);
  const [collapsed, setCollapsed] = useState(clientInitial);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }, []);

  return (
    <SidebarContext.Provider value={{ collapsed, toggle }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
