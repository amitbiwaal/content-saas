"use client";

import { useEffect, useState } from "react";

// The theme lives on <html data-theme> + localStorage, and the pre-hydration
// script in app/layout.tsx applies it before first paint (so there is no flash).
// This button therefore only has to sync its icon on mount and flip the
// attribute on click — which lets both headers (the app Shell and the marketing
// LandingHeader) share one implementation instead of keeping the logic twice.
const svg = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export default function ThemeToggle({ className = "hdr-icon-btn" }: { className?: string }) {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    setTheme(localStorage.getItem("theme") === "light" ? "light" : "dark");
  }, []);

  function toggle() {
    const root = document.documentElement;
    // Crossfade only while switching, then removed so it never interferes with
    // normal hover/focus transitions (see .theme-anim in globals.css).
    root.classList.add("theme-anim");
    window.setTimeout(() => root.classList.remove("theme-anim"), 420);
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("theme", next);
      } catch {
        /* private mode — the switch still applies for this session */
      }
      root.setAttribute("data-theme", next);
      return next;
    });
  }

  return (
    <button
      type="button"
      className={className}
      onClick={toggle}
      title="Toggle light / dark"
      aria-label="Toggle theme"
    >
      {theme === "dark" ? (
        // sun — click to go light
        <svg {...svg}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        // moon — click to go dark
        <svg {...svg}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
