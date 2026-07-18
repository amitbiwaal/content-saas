"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useLang } from "../lib/i18n";
import LandingHeader from "./LandingHeader";

export function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9Z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.1-4 1.1-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1C3.4 21.3 7.4 24 12 24Z" />
      <path fill="#FBBC05" d="M5.4 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3V6.6H1.4C.5 8.2 0 10 0 12s.5 3.8 1.4 5.4l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.4 0 3.4 2.7 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z" />
    </svg>
  );
}

export function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.9 10.9c.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.3.8 1 .8 2.1v3.1c0 .3.2.6.8.5A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

// Split-screen enterprise auth layout: aurora brand panel + centered form card.
export default function AuthShell({
  title, subtitle, children, footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useLang();
  const points = [
    t("Four frontier models research, debate & draft"),
    t("You approve every step — human in the loop"),
    t("Scored & gated before anything publishes"),
  ];
  const models = [
    { k: "openai", l: "O" }, { k: "anthropic", l: "A" },
    { k: "google", l: "G" }, { k: "xai", l: "X" },
  ];
  return (
    <div className="auth-page">
      {/* Full site header, same as the marketing pages (branding lives here now,
          so the panel/card no longer repeat the logo). */}
      <LandingHeader />

      <div className="auth">
      {/* Left: brand / value panel */}
      <aside className="auth-brand">
        <div className="auth-brand-fx" aria-hidden="true">
          <span className="auth-orb auth-orb-1" />
          <span className="auth-orb auth-orb-2" />
          <span className="auth-grid" />
        </div>
        <div className="auth-brand-inner">
          {/* The product story in one glance — four models debate, the Judge
              resolves, and the draft only ships once the score gate passes.
              Fills the dead space the panel leaves between logo and pitch. */}
          <div className="auth-vis" aria-hidden="true">
            <svg viewBox="0 0 380 250" className="auth-vis-svg" fill="none">
              <defs>
                <linearGradient id="avWire" x1="40" y1="0" x2="330" y2="0" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#10b981" stopOpacity="0.1" />
                  <stop offset="0.55" stopColor="#2dd4bf" stopOpacity="0.55" />
                  <stop offset="1" stopColor="#6ee7b7" stopOpacity="0.18" />
                </linearGradient>
                <radialGradient id="avGlow">
                  <stop offset="0" stopColor="#10b981" stopOpacity="0.4" />
                  <stop offset="1" stopColor="#10b981" stopOpacity="0" />
                </radialGradient>
              </defs>

              <circle className="auth-vis-glow" cx="186" cy="125" r="66" fill="url(#avGlow)" />

              {/* council seats → judge */}
              <g className="auth-vis-wires" stroke="url(#avWire)" strokeWidth="1.6">
                <path d="M51 50C112 50 118 125 156 125" />
                <path d="M51 100C112 100 126 125 156 125" />
                <path d="M51 150C112 150 126 125 156 125" />
                <path d="M51 200C112 200 118 125 156 125" />
              </g>

              {/* judge → draft */}
              <path d="M216 125h50" stroke="#2dd4bf" strokeWidth="1.6" strokeOpacity="0.5" />
              <path d="M261 120l5.5 5-5.5 5" stroke="#6ee7b7" strokeWidth="1.6" strokeOpacity="0.9" strokeLinecap="round" strokeLinejoin="round" />

              {/* the four seats, in their provider colours */}
              <g className="auth-vis-seats">
                <g>
                  <circle cx="36" cy="50" r="15" fill="#10b981" fillOpacity="0.16" stroke="#10b981" strokeOpacity="0.75" />
                  <text x="36" y="55" textAnchor="middle" fontSize="12" fontWeight="800" fill="#6ee7b7">O</text>
                </g>
                <g>
                  <circle cx="36" cy="100" r="15" fill="#c4a06e" fillOpacity="0.16" stroke="#c4a06e" strokeOpacity="0.75" />
                  <text x="36" y="105" textAnchor="middle" fontSize="12" fontWeight="800" fill="#dcc39a">A</text>
                </g>
                <g>
                  <circle cx="36" cy="150" r="15" fill="#7aa5ff" fillOpacity="0.16" stroke="#7aa5ff" strokeOpacity="0.75" />
                  <text x="36" y="155" textAnchor="middle" fontSize="12" fontWeight="800" fill="#a8c4ff">G</text>
                </g>
                <g>
                  <circle cx="36" cy="200" r="15" fill="#e2b15a" fillOpacity="0.16" stroke="#e2b15a" strokeOpacity="0.75" />
                  <text x="36" y="205" textAnchor="middle" fontSize="12" fontWeight="800" fill="#f0cd91" >X</text>
                </g>
              </g>

              {/* the Judge */}
              <polygon
                points="186,95 212,110 212,140 186,155 160,140 160,110"
                fill="#0b2b22"
                stroke="#10b981"
                strokeOpacity="0.85"
                strokeWidth="1.6"
              />
              <g transform="translate(175,114) scale(0.9)" stroke="#6ee7b7" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v18M7 8l-4 6h8L7 8ZM17 8l-4 6h8l-4-6ZM5 21h14" />
              </g>

              {/* the gated draft */}
              <rect x="272" y="85" width="74" height="80" rx="11" fill="#0b2b22" stroke="#10b981" strokeOpacity="0.4" strokeWidth="1.4" />
              <g fill="#6ee7b7" fillOpacity="0.5">
                <rect x="285" y="104" width="38" height="3.4" rx="1.7" />
                <rect x="285" y="116" width="48" height="3.4" rx="1.7" />
                <rect x="285" y="128" width="42" height="3.4" rx="1.7" />
                <rect x="285" y="140" width="30" height="3.4" rx="1.7" />
              </g>
              <circle className="auth-vis-tick" cx="344" cy="88" r="11" fill="#10b981" />
              <path d="M339.5 88.2l3 3 6-6.2" stroke="#04231a" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />

              <g fontSize="9.5" fontWeight="700" letterSpacing="1.2" fill="#7f95a2">
                <text x="36" y="240" textAnchor="middle">COUNCIL</text>
                <text x="186" y="240" textAnchor="middle">JUDGE</text>
                <text x="309" y="240" textAnchor="middle">PUBLISH</text>
              </g>
            </svg>
          </div>

          <div className="auth-brand-body">
            <h2 className="auth-brand-h">{t("Ship content the whole team trusts.")}</h2>
            <ul className="auth-brand-list">
              {points.map((p, i) => (
                <li key={i}><span className="auth-check-ic" aria-hidden="true">✓</span>{p}</li>
              ))}
            </ul>
          </div>
          <div className="auth-brand-models">
            <span className="auth-brand-models-label">{t("Powered by")}</span>
            <div className="auth-brand-avatars">
              {models.map((m) => (
                <span key={m.k} className="auth-model-av" data-p={m.k}>{m.l}</span>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* Right: form */}
      <main className="auth-main">
        <div className="auth-card">
          <h1 className="auth-title">{title}</h1>
          {subtitle && <p className="auth-sub">{subtitle}</p>}
          {children}
          {footer && <p className="auth-foot">{footer}</p>}
        </div>
        <p className="auth-legal">
          {t("Protected by reCAPTCHA · ")}
          <Link href="/terms" className="auth-link-mute">{t("Terms")}</Link>
          {" · "}
          <Link href="/privacy" className="auth-link-mute">{t("Privacy")}</Link>
        </p>
      </main>
      </div>
    </div>
  );
}
