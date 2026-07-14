"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { LANGS, useLang } from "../lib/i18n";
import type { Integrations, Project } from "../lib/types";

// Account identity — env-driven so no personal email is hardcoded in the shipped
// bundle. Set NEXT_PUBLIC_APP_USER_NAME / _EMAIL to populate (falls back to a
// neutral label). Real per-user identity awaits an auth/session layer.
const USER_NAME = process.env.NEXT_PUBLIC_APP_USER_NAME || "Account";
const USER_EMAIL = process.env.NEXT_PUBLIC_APP_USER_EMAIL || "";
// Credits/usage + plans are presentation-only for now (no billing backend yet).
const CREDITS = { remaining: 1240, total: 2000 };
const PLANS = [
  { name: "Free", price: "$0", credits: "500 credits / mo", features: ["1 active project", "Mock providers", "Markdown export"], cta: "Current plan", current: true },
  { name: "Pro", price: "$29", credits: "5,000 credits / mo", features: ["Unlimited projects", "Live AI provider keys", "WordPress publishing", "Priority council"], cta: "Upgrade to Pro", popular: true },
  { name: "Business", price: "$99", credits: "25,000 credits / mo", features: ["Everything in Pro", "Team seats", "Custom house rules", "API access"], cta: "Upgrade to Business" },
];

// --- Inline icons (Lucide/Feather style; inherit color via currentColor) ----
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

function Icon({ name }: { name: string }) {
  switch (name) {
    case "chat":
      return (
        <svg {...svg}>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
        </svg>
      );
    case "dashboard":
      return (
        <svg {...svg}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "projects":
      return (
        <svg {...svg}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "analytics":
      return (
        <svg {...svg}>
          <line x1="3" y1="20" x2="21" y2="20" />
          <rect x="5" y="11" width="3" height="7" rx="0.5" />
          <rect x="10.5" y="7" width="3" height="11" rx="0.5" />
          <rect x="16" y="13" width="3" height="5" rx="0.5" />
        </svg>
      );
    case "settings":
      return (
        <svg {...svg}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "plus":
      return (
        <svg {...svg}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "sun":
      return (
        <svg {...svg}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      );
    case "moon":
      return (
        <svg {...svg}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      );
    default:
      return null;
  }
}

const NAV = [
  { label: "Chat", href: "/chat", icon: "chat" },
  { label: "Dashboard", href: "/dashboard", icon: "dashboard" },
  { label: "Projects", href: "/projects", icon: "projects" },
  { label: "Analytics", href: "/analytics", icon: "analytics" },
  { label: "Settings", href: "/settings", icon: "settings" },
];

export default function Shell({
  title,
  status,
  children,
}: {
  title: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [recent, setRecent] = useState<Project[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [userOpen, setUserOpen] = useState(false);
  const [integ, setInteg] = useState<Integrations | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const { lang, setLang, t } = useLang();
  const currentLang = LANGS.find((l) => l.code === lang) ?? LANGS[0];

  // Close the account menu on an outside click or Escape (standard dropdown UX).
  useEffect(() => {
    if (!userOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUserOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [userOpen]);

  // Same close-on-outside-click for the language menu.
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

  useEffect(() => {
    setCollapsed(localStorage.getItem("sidebarCollapsed") === "1");
    setTheme(localStorage.getItem("theme") === "light" ? "light" : "dark");
    api.getIntegrations().then(setInteg).catch(() => {});
  }, []);

  const usedPct = Math.round(((CREDITS.total - CREDITS.remaining) / CREDITS.total) * 100);
  const wpConnected = !!integ?.wordpress.configured;

  function toggleTheme() {
    const root = document.documentElement;
    root.classList.add("theme-anim");
    window.setTimeout(() => root.classList.remove("theme-anim"), 420);
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem("theme", next);
      root.setAttribute("data-theme", next);
      return next;
    });
  }
  useEffect(() => {
    api.listProjects().then((p) => setRecent(p.slice(0, 8))).catch(() => {});
  }, [pathname]);

  function toggleCollapse() {
    setCollapsed((c) => {
      localStorage.setItem("sidebarCollapsed", c ? "0" : "1");
      return !c;
    });
  }

  function logout() {
    setUserOpen(false);
    // No auth backend yet — clear local session-ish state and return home.
    try {
      localStorage.removeItem("sidebarCollapsed");
    } catch {
      /* ignore */
    }
    window.location.href = "/";
  }

  return (
    <div className={`app ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}`}>
      {mobileOpen && <div className="backdrop" onClick={() => setMobileOpen(false)} />}

      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <span className="brand-full">ContentOS<span className="brand-ai"> AI</span></span>
        </div>

        <a className="newchat" href="/chat" title="New chat">
          <span className="nav-icon"><Icon name="plus" /></span>
          <span className="brand-full">{t("New chat")}</span>
        </a>

        <nav>
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item ${active ? "active" : ""}`}
                onClick={() => setMobileOpen(false)}
                title={t(item.label)}
              >
                <span className="nav-icon"><Icon name={item.icon} /></span>
                <span className="brand-full">{t(item.label)}</span>
              </Link>
            );
          })}
        </nav>

        {recent.length > 0 && (
          <div className="recent brand-full">
            <div className="recent-title">{t("Recent")}</div>
            {recent.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="recent-item"
                onClick={() => setMobileOpen(false)}
                title={p.topic}
              >
                <span className={`dot stage-${p.stage}`} />
                <span className="recent-text">{p.topic}</span>
              </Link>
            ))}
          </div>
        )}

        <div className="side-bottom">
        <div className="side-billing brand-full">
          <Link href="/settings" className="wp-connect" onClick={() => setMobileOpen(false)}>
            <span className={`wp-dot ${wpConnected ? "on" : ""}`} />
            <span className="wp-connect-text">{wpConnected ? t("WordPress connected") : t("Connect WordPress")}</span>
            <span className="wp-chevron">›</span>
          </Link>
        </div>

        <div className="side-foot">
          <button className="collapse-btn" onClick={toggleCollapse} title="Collapse sidebar">
            {collapsed ? "»" : "«"}<span className="brand-full"> {t("Collapse")}</span>
          </button>
        </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button className="hamburger" onClick={() => setMobileOpen((o) => !o)} aria-label="Menu">☰</button>
            <h1>{t(title)}</h1>
          </div>

          <div className="topbar-right">
            {status}
            <div className="hdr-credits" title={`${usedPct}% of ${CREDITS.total.toLocaleString()} used this month`}>
              <span className="hdr-credits-num">{CREDITS.remaining.toLocaleString()}</span>
              <span className="hdr-credits-label">{t("credits left")}</span>
            </div>
            <button className="hdr-upgrade" onClick={() => setUpgradeOpen(true)}>⚡ {t("Upgrade")}</button>

            {/* Language selector */}
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

            <button className="hdr-icon-btn" onClick={toggleTheme} title="Toggle light / dark" aria-label="Toggle theme">
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>

            <div className="user-box hdr-user" ref={userRef}>
              <button className={`user-btn ${userOpen ? "open" : ""}`} onClick={() => setUserOpen((o) => !o)} title="Account">
                <span className="user-avatar">{USER_NAME.charAt(0).toUpperCase()}</span>
                <span className="hdr-user-name">{USER_NAME}</span>
                <span className="user-caret" aria-hidden="true">⌃</span>
              </button>
              {userOpen && (
                <div className="user-menu">
                  {USER_EMAIL && <div className="user-menu-email">{USER_EMAIL}</div>}
                  <Link href="/settings" className="user-menu-item" onClick={() => setUserOpen(false)}>{t("Settings")}</Link>
                  <Link href="/dashboard" className="user-menu-item" onClick={() => setUserOpen(false)}>{t("Dashboard")}</Link>
                  <button className="user-menu-item danger" onClick={logout}>{t("Log out")}</button>
                </div>
              )}
            </div>
          </div>
        </header>
        {children}
      </main>

      {upgradeOpen && (
        <div className="pricing-modal" onClick={() => setUpgradeOpen(false)}>
          <div className="pricing-card" onClick={(e) => e.stopPropagation()}>
            <div className="pricing-head">
              <div>
                <h3>{t("Upgrade your plan")}</h3>
                <p className="muted small">{t("You have")} {CREDITS.remaining.toLocaleString()} {t("of")} {CREDITS.total.toLocaleString()} {t("credits left this month.")}</p>
              </div>
              <button className="pricing-close" onClick={() => setUpgradeOpen(false)} aria-label={t("Close")}>✕</button>
            </div>
            <div className="pricing-grid">
              {PLANS.map((p) => (
                <div key={p.name} className={`plan ${p.popular ? "popular" : ""}`}>
                  {p.popular && <span className="plan-badge">{t("Most popular")}</span>}
                  <div className="plan-name">{t(p.name)}</div>
                  <div className="plan-price">{p.price}<span>{t("/mo")}</span></div>
                  <div className="plan-credits">{t(p.credits)}</div>
                  <ul className="plan-features">{p.features.map((f) => <li key={f}>{t(f)}</li>)}</ul>
                  <button className={`plan-cta ${p.popular ? "btn btn-primary" : "btn"}`} disabled={p.current}>{t(p.cta)}</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
