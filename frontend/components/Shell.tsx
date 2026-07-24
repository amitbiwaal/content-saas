"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { getToken, logout as doLogout, redirectToLogin, type AuthUser } from "../lib/auth";
import { useLang } from "../lib/i18n";
import type { Project } from "../lib/types";
import { PAYMENTS_ENABLED, PLANS } from "../lib/pricing";
import ThemeToggle from "./ThemeToggle";

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
    case "shield":
      return (
        <svg {...svg}>
          <path d="M12 3l7 3v5c0 4.4-2.9 8.2-7 9.5C7.9 19.2 5 15.4 5 11V6l7-3Z" />
          <path d="M9.2 12l1.8 1.8L15 9.8" />
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
  const [userOpen, setUserOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);
  const { t } = useLang();

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

  useEffect(() => {
    setCollapsed(localStorage.getItem("sidebarCollapsed") === "1");
    // Auth gate: no token => straight to sign-in. Otherwise load the account
    // (name, email, credit balance) and refresh it when a run charges credits.
    if (!getToken()) {
      redirectToLogin();
      return;
    }
    const load = () => api.auth.me().then(setUser).catch(() => {});
    load();
    const onCredits = () => load();
    window.addEventListener("credits:changed", onCredits);
    return () => window.removeEventListener("credits:changed", onCredits);
  }, []);

  // null while the account is still loading — the chip shows "…" instead of a
  // misleading "0 credits left" flash.
  const credits = user ? user.credits : null;
  const displayName = user?.name || user?.email || "Account";
  const displayEmail = user?.email || "";
  const wpConnected = !!user?.has_wordpress;
  // The WordPress connect shortcut is a per-user setting; keep it off the admin
  // pages, which are for managing other accounts (it still lives in Settings).
  const onAdmin = pathname === "/admin" || pathname.startsWith("/admin/");

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
    doLogout(); // clears the token and redirects to /login
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
          {user?.is_admin && (
            <Link
              href="/admin"
              className={`nav-item ${pathname === "/admin" || pathname.startsWith("/admin/") ? "active" : ""}`}
              onClick={() => setMobileOpen(false)}
              title={t("Admin")}
            >
              <span className="nav-icon"><Icon name="shield" /></span>
              <span className="brand-full">{t("Admin")}</span>
            </Link>
          )}
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
        {!onAdmin && (
          <div className="side-billing brand-full">
            <Link href="/settings" className="wp-connect" onClick={() => setMobileOpen(false)}>
              <span className={`wp-dot ${wpConnected ? "on" : ""}`} />
              <span className="wp-connect-text">{wpConnected ? t("WordPress connected") : t("Connect WordPress")}</span>
              <span className="wp-chevron">›</span>
            </Link>
          </div>
        )}

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
            <Link href="/settings" className="hdr-credits" title={t("Credits remaining")}>
              <span className="hdr-credits-num">{credits === null ? "…" : credits.toLocaleString("en-US")}</span>
              <span className="hdr-credits-label">{t("credits left")}</span>
            </Link>
            <button className="hdr-upgrade" onClick={() => setUpgradeOpen(true)}>⚡ {t("Upgrade")}</button>

            <ThemeToggle />

            <div className="user-box hdr-user" ref={userRef}>
              <button className={`user-btn ${userOpen ? "open" : ""}`} onClick={() => setUserOpen((o) => !o)} title="Account">
                <span className="user-avatar">{displayName.charAt(0).toUpperCase()}</span>
                <span className="hdr-user-name">{displayName}</span>
                <span className="user-caret" aria-hidden="true">⌃</span>
              </button>
              {userOpen && (
                <div className="user-menu">
                  {displayEmail && <div className="user-menu-email">{displayEmail}</div>}
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
                <p className="muted small">
                  {t("You have")} {(credits ?? 0).toLocaleString("en-US")} {t("credits left.")}
                  {!PAYMENTS_ENABLED && <> · {t("Self-serve upgrades are coming soon.")}</>}
                </p>
              </div>
              <button className="pricing-close" onClick={() => setUpgradeOpen(false)} aria-label={t("Close")}>✕</button>
            </div>
            <div className="pricing-grid">
              {PLANS.map((p) => {
                const isCurrent = (user?.plan ?? "free") === p.id;
                const soon = !PAYMENTS_ENABLED && p.monthly > 0 && !isCurrent;
                return (
                  <div key={p.id} className={`plan ${p.popular ? "popular" : ""} ${isCurrent ? "plan-current" : ""}`}>
                    {p.popular && <span className="plan-badge">{t("Most popular")}</span>}
                    <div className="plan-name">{t(p.name)}</div>
                    <div className="plan-price">${p.monthly}<span>{t("/mo")}</span></div>
                    <div className="plan-credits">{p.credits.toLocaleString("en-US")} {t("credits / mo")}</div>
                    <ul className="plan-features">{p.features.map((f) => <li key={f}>{t(f)}</li>)}</ul>
                    <button
                      className={`plan-cta ${p.popular && !isCurrent && !soon ? "btn btn-primary" : "btn"}`}
                      disabled={isCurrent || soon}
                    >
                      {isCurrent ? t("Current plan") : soon ? t("Coming soon") : t(p.cta)}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
