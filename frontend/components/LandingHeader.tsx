"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLang } from "../lib/i18n";
import ThemeToggle from "./ThemeToggle";

// Section links are absolute ("/#id") so they also work from the sub-pages that
// share this header (pricing, about, contact, legal) — from the homepage the
// browser still just scrolls in place. Pricing has its own page.
const LINKS = [
  { label: "How it works", href: "/#how" },
  { label: "The Council", href: "/#council" },
  { label: "Scoring", href: "/#scoring" },
  { label: "Publish", href: "/#publish" },
  { label: "Pricing", href: "/pricing" },
];

export default function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { t } = useLang();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`lp-header ${scrolled ? "scrolled" : ""}`}>
      <div className="lp-header-inner">
        <Link href="/" className="lp-brand" onClick={() => setOpen(false)}>
          <span className="brand-mark">C</span>
          <span className="lp-brand-name">
            ContentOS<span className="brand-ai"> AI</span>
          </span>
        </Link>

        <nav className="lp-nav">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="lp-navlink">
              {t(l.label)}
            </Link>
          ))}
        </nav>

        <div className="lp-actions">
          <ThemeToggle />
          <Link href="/login" className="lp-signin">
            {t("Sign in")}
          </Link>
          <Link href="/chat" className="lp-cta">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            {t("Start free")}
          </Link>
        </div>

        <button
          className={`lp-burger ${open ? "open" : ""}`}
          onClick={() => setOpen((o) => !o)}
          aria-label="Menu"
          aria-expanded={open}
        >
          <span />
          <span />
          <span />
        </button>
      </div>

      <div className={`lp-mobile ${open ? "open" : ""}`}>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="lp-mobile-link" onClick={() => setOpen(false)}>
            {t(l.label)}
          </Link>
        ))}
        <Link href="/chat" className="lp-cta lp-cta-mobile" onClick={() => setOpen(false)}>
          {t("Start free")} →
        </Link>
      </div>
    </header>
  );
}
