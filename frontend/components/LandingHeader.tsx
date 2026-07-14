"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LANGS, useLang } from "../lib/i18n";

const LINKS = [
  { label: "How it works", href: "#how" },
  { label: "The Council", href: "#council" },
  { label: "Scoring", href: "#scoring" },
  { label: "Publish", href: "#publish" },
  { label: "Pricing", href: "#pricing" },
];

export default function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const { lang, setLang, t } = useLang();
  const currentLang = LANGS.find((l) => l.code === lang) ?? LANGS[0];

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!langOpen) return;
    const onDown = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLangOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [langOpen]);

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
            <a key={l.href} href={l.href} className="lp-navlink">
              {t(l.label)}
            </a>
          ))}
        </nav>

        <div className="lp-actions">
          <div className="user-box hdr-lang" ref={langRef}>
            <button className={`hdr-lang-btn ${langOpen ? "open" : ""}`} onClick={() => setLangOpen((o) => !o)} title={t("Language")} aria-label={t("Language")}>
              <span className="hdr-lang-flag">{currentLang.flag}</span>
              <span className="hdr-lang-code">{currentLang.code.toUpperCase()}</span>
            </button>
            {langOpen && (
              <div className="user-menu hdr-lang-menu">
                <div className="user-menu-email">{t("Language")}</div>
                {LANGS.map((l) => (
                  <button
                    key={l.code}
                    className={`user-menu-item ${l.code === lang ? "lang-active" : ""}`}
                    onClick={() => { setLang(l.code); setLangOpen(false); }}
                  >
                    <span className="hdr-lang-flag">{l.flag}</span> {l.label}{l.code === lang ? "  ✓" : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Link href="/chat" className="lp-signin">
            {t("Sign in")}
          </Link>
          <Link href="/chat" className="lp-cta">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            {t("Launch app")}
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
          <a key={l.href} href={l.href} className="lp-mobile-link" onClick={() => setOpen(false)}>
            {t(l.label)}
          </a>
        ))}
        <Link href="/chat" className="lp-cta lp-cta-mobile" onClick={() => setOpen(false)}>
          {t("Launch app")} →
        </Link>
      </div>
    </header>
  );
}
