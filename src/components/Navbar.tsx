"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import SearchBar from "@/components/SearchBar";
import { useSidebar } from "@/components/SidebarContext";
import AboutModal from "@/components/AboutModal";

interface NavbarProps {
  instanceName: string;
  logoUrl: string;
  aboutText: string;
}

const HIDDEN_PATHS = ["/setup", "/admin", "/login"];

export default function Navbar({ instanceName, logoUrl, aboutText }: NavbarProps) {
  const pathname = usePathname();
  const { toggle } = useSidebar();
  const [aboutOpen, setAboutOpen] = useState(false);

  // Listen for "open-about" events from the sidebar
  useEffect(() => {
    function handleOpenAbout() {
      setAboutOpen(true);
    }
    window.addEventListener("open-about", handleOpenAbout);
    return () => window.removeEventListener("open-about", handleOpenAbout);
  }, []);

  const shouldHide = HIDDEN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );

  if (shouldHide) return null;

  return (
    <>
      <nav
        className="sticky top-0 z-50"
        style={{
          backgroundColor: "var(--theme-bg)",
          boxShadow: "0 1px 0 0 rgba(255,255,255,0.1)",
        }}
      >
        <div className="flex h-14 items-center gap-4 px-4">
          {/* Left: Hamburger + Logo (opens About modal) */}
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={toggle}
              className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-[var(--theme-bg-secondary)]"
              style={{ color: "var(--theme-text)" }}
              aria-label="Toggle sidebar"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <Link
              href="/"
              className="flex items-center gap-2 transition-opacity hover:opacity-80"
            >
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt={instanceName}
                  className="h-8 object-contain"
                />
              ) : (
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-white"
                  style={{ backgroundColor: "var(--theme-primary)" }}
                >
                  {instanceName.charAt(0).toUpperCase()}
                </div>
              )}
              <span
                className="hidden text-xl font-bold tracking-tight sm:block"
                style={{ color: "var(--theme-heading)" }}
              >
                {instanceName}
              </span>
            </Link>
          </div>

          {/* Center/Right: Search — takes full remaining space */}
          <div className="flex min-w-0 flex-1 justify-center">
            <SearchBar />
          </div>
        </div>
      </nav>

      <AboutModal
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        aboutText={aboutText}
        instanceName={instanceName}
      />
    </>
  );
}
