"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import LandingHeader from "../components/LandingHeader";
import { useLang } from "../lib/i18n";

const SURFACES = ["Google", "AI Overviews", "ChatGPT", "Perplexity"];

const PROVIDERS = [
  { key: "openai", name: "OpenAI", role: "Content Strategist" },
  { key: "anthropic", name: "Claude", role: "Human Editor" },
  { key: "google", name: "Gemini", role: "Search Intelligence" },
  { key: "xai", name: "Grok", role: "Trend Analyst" },
];

// Real brand marks (simple-icons paths) in their own brand colours.
function ProviderLogo({ k }: { k: string }) {
  switch (k) {
    case "openai":
      return (
        <svg viewBox="0 0 24 24" fill="#f4f8f6" aria-hidden="true">
          <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
        </svg>
      );
    case "anthropic":
      return (
        <svg viewBox="0 0 24 24" fill="#d97757" aria-hidden="true">
          <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.541Zm-.3712 10.2426 2.2914-5.9456 2.2914 5.9456Z" />
        </svg>
      );
    case "google":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <defs>
            <linearGradient id="lpGem" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#4796e3" />
              <stop offset="0.5" stopColor="#9177c7" />
              <stop offset="1" stopColor="#d96570" />
            </linearGradient>
          </defs>
          <path fill="url(#lpGem)" d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12" />
        </svg>
      );
    case "xai":
      return (
        <svg viewBox="0 0 24 24" fill="#f4f8f6" aria-hidden="true">
          <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
        </svg>
      );
    default:
      return null;
  }
}

// Council seats shown in the product mockup — provider color-coding encodes meaning.
const SEATS = [
  { p: "openai", mono: "O", role: "Content Strategist", model: "OpenAI", conf: 92, status: "done" },
  { p: "anthropic", mono: "A", role: "Human Editor", model: "Claude", conf: 88, status: "done" },
  { p: "google", mono: "G", role: "Search Intelligence", model: "Gemini", conf: 90, status: "done" },
  { p: "xai", mono: "X", role: "Trend Analyst", model: "Grok", conf: 84, status: "live" },
];

const STEPS = [
  { label: "Research", state: "done" },
  { label: "Council", state: "done" },
  { label: "Judge", state: "active" },
  { label: "Draft", state: "pending" },
  { label: "Score", state: "pending" },
  { label: "Publish", state: "pending" },
];

const SCORES = [
  { label: "SEO", value: 88 },
  { label: "AEO", value: 86 },
  { label: "GEO", value: 82 },
  { label: "HEO", value: 87 },
];

export default function LandingPage() {
  const { t } = useLang();
  const [surface, setSurface] = useState(0);
  const howTrackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = window.setInterval(
      () => setSurface((s) => (s + 1) % SURFACES.length),
      2200,
    );
    return () => window.clearInterval(id);
  }, []);

  // Fire the pipeline "charge" animation when the section scrolls into view.
  useEffect(() => {
    const el = howTrackRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add("in");
            io.disconnect();
          }
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <>
      <LandingHeader />

      <main className="lp">
        <section className="lp-hero">
          <div className="lp-hero-fx" aria-hidden="true">
            <span className="lp-orb lp-orb-1" />
            <span className="lp-orb lp-orb-2" />
            <span className="lp-grid" />
          </div>

          <div className="lp-hero-inner">
            <span className="lp-eyebrow fade-in">
              <span className="lp-eyebrow-dot" />
              {t("Multi-model AI content engine")}
              <span className="lp-eyebrow-tag">v1.0</span>
            </span>

            <h1 className="lp-h1 fade-in" style={{ animationDelay: "0.05s" }}>
              {t("Four AI models debate. One judge decides.")}
              <br />
              <span className="lp-h1-line">
                {t("Content that ranks on")}{" "}
                <span className="lp-rotator">
                  {SURFACES.map((s, i) => (
                    <span
                      key={s}
                      className={`lp-rotator-word ${i === surface ? "on" : ""}`}
                    >
                      {s}
                    </span>
                  ))}
                </span>
              </span>
            </h1>

            <p className="lp-sub fade-in" style={{ animationDelay: "0.12s" }}>
              {t("ContentOS runs one brief through OpenAI, Claude, Gemini and Grok at once. They argue, a Judge resolves every conflict with reasons you can override, and each article is fact-checked and graded on four search surfaces before an eight-score gate lets it publish.")}
            </p>

            <div className="lp-cta-row fade-in" style={{ animationDelay: "0.2s" }}>
              <Link href="/chat" className="lp-btn-primary">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                {t("Start writing free")}
              </Link>
              <a href="#how" className="lp-btn-ghost">
                <span className="lp-play" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                    <polygon points="6 4 20 12 6 20 6 4" />
                  </svg>
                </span>
                {t("See the council debate")}
              </a>
            </div>

            <p className="lp-reassure fade-in" style={{ animationDelay: "0.24s" }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              {t("No card required")}
              <span className="lp-reassure-dot" />
              {t("Runs free on mock providers")}
              <span className="lp-reassure-dot" />
              {t("Publish-ready in one pass")}
            </p>

            <div className="lp-trust fade-in" style={{ animationDelay: "0.28s" }}>
              <span className="lp-trust-label">{t("Powered by the frontier models")}</span>
              <div className="lp-models">
                {PROVIDERS.map((p) => (
                  <div key={p.key} className="lp-model" data-p={p.key}>
                    <span className="lp-model-logo">
                      <ProviderLogo k={p.key} />
                    </span>
                    <span className="lp-model-name">{p.name}</span>
                    <span className="lp-model-role">{p.role}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Product showcase — the AI council "cockpit", built in pure CSS */}
          <div className="lp-showcase fade-in" style={{ animationDelay: "0.36s" }}>
            <div className="lp-cockpit">
              <div className="lp-win-bar">
                <span className="lp-dots">
                  <span className="lp-dot" />
                  <span className="lp-dot" />
                  <span className="lp-dot" />
                </span>
                <span className="lp-win-title">
                  FeetFinder Review 2026 · council in session
                </span>
                <span className="lp-live">
                  <span className="lp-live-dot" />
                  Live
                </span>
              </div>

              <div className="lp-win-body">
                {/* Pipeline rail */}
                <aside className="lp-rail">
                  <div className="lp-rail-title">Pipeline</div>
                  <ul className="lp-steps">
                    {STEPS.map((s) => (
                      <li key={s.label} className={`lp-step ${s.state}`}>
                        <span className="lp-step-node" />
                        {s.label}
                      </li>
                    ))}
                  </ul>
                </aside>

                {/* Council seats + judge */}
                <div className="lp-main">
                  <div className="lp-main-head">
                    <span>AI Council</span>
                    <span className="lp-chip-round">Round 2 · debate</span>
                  </div>
                  <div className="lp-seats">
                    {SEATS.map((s) => (
                      <div key={s.role} className="lp-seat" data-p={s.p}>
                        <div className="lp-seat-top">
                          <span className="lp-seat-av">{s.mono}</span>
                          <span className="lp-seat-meta">
                            <span className="lp-seat-role">{s.role}</span>
                            <span className="lp-seat-model">{s.model}</span>
                          </span>
                          <span className={`lp-seat-status ${s.status}`}>
                            {s.status === "live" ? "typing…" : "✓"}
                          </span>
                        </div>
                        <div className="lp-conf">
                          <span className="lp-conf-bar" style={{ width: `${s.conf}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="lp-judge">
                    <div className="lp-judge-head">
                      <span className="lp-judge-badge">Judge</span>
                      resolving conflicts
                    </div>
                    <div className="lp-judge-rows">
                      <span className="lp-verdict accepted">Accepted · 20% fee (sourced)</span>
                      <span className="lp-verdict rejected">Rejected · “safest platform”</span>
                      <span className="lp-verdict merge">Merge · payout-trust section</span>
                    </div>
                  </div>
                </div>

                {/* Score panel */}
                <aside className="lp-scorepanel">
                  <div className="lp-ring">
                    <svg viewBox="0 0 120 120" width="104" height="104">
                      <circle className="lp-ring-track" cx="60" cy="60" r="52" />
                      <circle
                        className="lp-ring-fill"
                        cx="60"
                        cy="60"
                        r="52"
                        strokeDasharray="326.7"
                        strokeDashoffset="42.5"
                      />
                    </svg>
                    <span className="lp-ring-label">
                      <b>87</b>
                      Publish
                    </span>
                  </div>
                  <div className="lp-scores">
                    {SCORES.map((s) => (
                      <div key={s.label} className="lp-score">
                        <span className="lp-score-top">
                          <span>{s.label}</span>
                          <span className="lp-score-val">{s.value}</span>
                        </span>
                        <span className="lp-score-bar">
                          <span style={{ width: `${s.value}%` }} />
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="lp-gate">
                    <span className="lp-gate-tick">✓</span> Gate passed · 0 high-risk claims
                  </div>
                </aside>
              </div>
            </div>

            {/* Floating stat cards */}
            <div className="lp-float lp-float-a">
              <span className="lp-float-k">27 min</span>
              <span className="lp-float-v">brief → draft</span>
            </div>
            <div className="lp-float lp-float-b">
              <span className="lp-float-k">4 models</span>
              <span className="lp-float-v">one reconciled strategy</span>
            </div>
            <div className="lp-float lp-float-c">
              <span className="lp-float-k">Fact 81</span>
              <span className="lp-float-v">every claim sourced</span>
            </div>
          </div>
        </section>

        {/* ===== How it works — horizontal assembly-line pipeline ===== */}
        <section id="how" className="lp-how" aria-labelledby="lp-how-title">
          <div className="lp-how-inner">
            <div className="lp-how-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("Brief in, published out")}
                <span className="lp-eyebrow-tag">6 STAGES</span>
              </span>
              <h2 id="lp-how-title" className="lp-how-title">
                {t("One brief. Four minds.")}{" "}
                <span className="lp-how-grad">{t("Six stages")}</span> {t("to publish-ready.")}
              </h2>
              <p className="lp-how-sub">
                {t("Watch a single brief move down the line: research, a four-model council debate, a reasoned Judge, draft, and an eight-score publish gate. Nothing ships until it earns it.")}
              </p>
            </div>

            <div
              className="lp-how-track"
              ref={howTrackRef}
              role="list"
              aria-label="How ContentOS works, six stages"
            >
              {HOW_STEPS.map((s, i) => (
                <article
                  className="lp-how-card"
                  role="listitem"
                  style={{ "--i": i } as React.CSSProperties}
                  key={s.n}
                >
                  <span className="lp-how-bignum" aria-hidden="true">{s.n}</span>
                  <div className="lp-how-card-main">
                    <span className="lp-how-icon">{s.icon}</span>
                    <h3 className="lp-how-card-title">{s.title}</h3>
                    <p className="lp-how-card-desc">{s.desc}</p>
                  </div>
                  <div className="lp-how-card-vis">{s.visual}</div>
                </article>
              ))}
            </div>

            <div className="lp-how-foot fade-in">
              <Link href="/chat" className="lp-btn-primary">
                {t("Start a brief")}
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
              </Link>
              <span className="lp-how-foot-note">
                {t("Brief to publish-ready in a single pass.")}
              </span>
            </div>
          </div>
        </section>
        {/* ===== section: why ===== */}
        <section className="lp-why">
          <div className="lp-why-inner">
            <div className="lp-why-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("Why ContentOS")}
              </span>
              <h2 className="lp-why-title">
                {t("One brief, four minds, and a gate that")}{" "}
                <span className="lp-why-grad">{t("nothing weak gets past")}</span>
              </h2>
              <p className="lp-why-sub">
                {t("Most tools wrap a single model in a nicer UI. ContentOS runs a multi-model debate, verifies every claim, and scores each article across four search surfaces before it can ship.")}
              </p>
            </div>

            <div className="lp-why-grid">
              <article className="lp-why-card lp-rise">
                <span className="lp-why-chip" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="2.4" />
                    <circle cx="18" cy="6" r="2.4" />
                    <circle cx="6" cy="18" r="2.4" />
                    <circle cx="18" cy="18" r="2.4" />
                    <path d="M8.4 6h7.2M8.4 18h7.2M6 8.4v7.2M18 8.4v7.2M7.7 7.7l8.6 8.6M16.3 7.7l-8.6 8.6" />
                  </svg>
                </span>
                <h3 className="lp-why-card-title">Multi-model, not single-AI</h3>
                <p className="lp-why-card-desc">
                  Four models debate, so you get a reconciled strategy, not one
                  model&rsquo;s bias or one detectable voice.
                </p>
              </article>

              <article className="lp-why-card lp-rise">
                <span className="lp-why-chip" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v18" />
                    <path d="M12 5 5 8m7-3 7 3" />
                    <path d="M5 8l-2.6 5.2a3 3 0 0 0 5.2 0L5 8Z" />
                    <path d="M19 8l-2.6 5.2a3 3 0 0 0 5.2 0L19 8Z" />
                    <path d="M8 21h8" />
                  </svg>
                </span>
                <h3 className="lp-why-card-title">A Judge you can override</h3>
                <p className="lp-why-card-desc">
                  Every recommendation is accepted, rejected or merged with a
                  human-readable reason you can change.
                </p>
              </article>

              <article className="lp-why-card lp-rise">
                <span className="lp-why-chip" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 12.5l2 2 4-4.5" />
                    <path d="M20 12a8 8 0 1 1-3.4-6.5" />
                    <path d="M20 4.5V8h-3.5" />
                  </svg>
                </span>
                <h3 className="lp-why-card-title">Fact-checked before it ships</h3>
                <p className="lp-why-card-desc">
                  Every claim gets a source, confidence and risk. High-risk
                  unsupported claims block the gate.
                </p>
              </article>

              <article className="lp-why-card lp-rise">
                <span className="lp-why-chip" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
                    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
                    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
                    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
                  </svg>
                </span>
                <h3 className="lp-why-card-title">Four search surfaces at once</h3>
                <p className="lp-why-card-desc">
                  SEO, AEO, GEO and HEO scored together, not stitched from separate
                  tools.
                </p>
              </article>

              <article className="lp-why-card lp-rise">
                <span className="lp-why-chip" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3l7 3v5c0 4.4-2.9 8.2-7 9.5C7.9 19.2 5 15.4 5 11V6l7-3Z" />
                    <path d="M9.2 12l1.8 1.8L15 9.8" />
                  </svg>
                </span>
                <h3 className="lp-why-card-title">Built for restricted niches</h3>
                <p className="lp-why-card-desc">
                  Policy-tier routing sends adult-adjacent topics to permissive
                  providers, with no refusals and no diluted output.
                </p>
              </article>

              <article className="lp-why-card lp-rise">
                <span className="lp-why-chip" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v3m0 12v3" />
                    <path d="M15 8.2a3 3 0 0 0-3-1.7c-1.9 0-3 1-3 2.4 0 3.4 6.4 1.8 6.4 5.4 0 1.5-1.3 2.6-3.4 2.6a3.4 3.4 0 0 1-3.2-1.9" />
                  </svg>
                </span>
                <h3 className="lp-why-card-title">Cost-aware, one-click publish</h3>
                <p className="lp-why-card-desc">
                  Budget caps and cheaper models for research seats. One-click
                  WordPress with RankMath or Yoast mapping.
                </p>
              </article>
            </div>
          </div>
        </section>

        {/* ===== section: cn ===== */}
        <section id="council" className="lp-cn">
          <div className="lp-cn-inner">
            <div className="lp-cn-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("The council")}
              </span>
              <h2 className="lp-cn-title">
                {t("Four specialists debate. One")}{" "}
                <span className="lp-cn-grad">{t("reconciled strategy")}</span> {t("ships.")}
              </h2>
              <p className="lp-cn-sub">
                {t("Each model is given a role and runs in parallel, then challenges the others. A Judge resolves every conflict, so you get one strategy, not four opinions.")}
              </p>
            </div>

            <ul className="lp-cn-seats">
              <li className="lp-cn-seat lp-cn-reveal" data-provider="openai">
                <span className="lp-cn-accent" aria-hidden="true" />
                <div className="lp-cn-seat-top">
                  <span className="lp-cn-avatar" aria-hidden="true">O</span>
                  <span className="lp-cn-provider">OpenAI</span>
                </div>
                <h3 className="lp-cn-role">Content Strategist</h3>
                <p className="lp-cn-owns">
                  <span className="lp-cn-owns-label">Owns</span>
                  Brief and outline logic: intent, section order, priority.
                </p>
              </li>

              <li className="lp-cn-seat lp-cn-reveal" data-provider="anthropic">
                <span className="lp-cn-accent" aria-hidden="true" />
                <div className="lp-cn-seat-top">
                  <span className="lp-cn-avatar" aria-hidden="true">A</span>
                  <span className="lp-cn-provider">Claude</span>
                </div>
                <h3 className="lp-cn-role">Human Editor</h3>
                <p className="lp-cn-owns">
                  <span className="lp-cn-owns-label">Owns</span>
                  Natural tone and balance. No over-promising or unsupported superlatives.
                </p>
              </li>

              <li className="lp-cn-seat lp-cn-reveal" data-provider="google">
                <span className="lp-cn-accent" aria-hidden="true" />
                <div className="lp-cn-seat-top">
                  <span className="lp-cn-avatar" aria-hidden="true">G</span>
                  <span className="lp-cn-provider">Gemini</span>
                </div>
                <h3 className="lp-cn-role">Search Intelligence</h3>
                <p className="lp-cn-owns">
                  <span className="lp-cn-owns-label">Owns</span>
                  Entities, answer blocks, FAQ design and citation readiness (AEO and GEO).
                </p>
              </li>

              <li className="lp-cn-seat lp-cn-reveal" data-provider="xai">
                <span className="lp-cn-accent" aria-hidden="true" />
                <div className="lp-cn-seat-top">
                  <span className="lp-cn-avatar" aria-hidden="true">X</span>
                  <span className="lp-cn-provider">Grok</span>
                </div>
                <h3 className="lp-cn-role">Trend Analyst</h3>
                <p className="lp-cn-owns">
                  <span className="lp-cn-owns-label">Owns</span>
                  Fresh angles and the real questions people ask on social and Reddit.
                </p>
              </li>
            </ul>

            <div className="lp-cn-protocol">
              <div className="lp-cn-protocol-head">
                <span className="lp-cn-protocol-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 10h8M8 13.5h5" /><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2Z" /></svg>
                </span>
                <span className="lp-cn-protocol-title">Debate protocol</span>
              </div>

              <div className="lp-cn-rounds">
                <div className="lp-cn-round">
                  <span className="lp-cn-round-num">1</span>
                  <div className="lp-cn-round-body">
                    <span className="lp-cn-round-name">Reports</span>
                    <span className="lp-cn-round-desc">
                      All models run in parallel and return three to six recommendations
                      each, with a confidence score.
                    </span>
                  </div>
                </div>
                <span className="lp-cn-round-arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
                </span>
                <div className="lp-cn-round">
                  <span className="lp-cn-round-num">2</span>
                  <div className="lp-cn-round-body">
                    <span className="lp-cn-round-name">Debate</span>
                    <span className="lp-cn-round-desc">
                      Each model reads the others and challenges them. At least one real
                      conflict is surfaced, not hidden.
                    </span>
                  </div>
                </div>
                <span className="lp-cn-round-arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
                </span>
                <div className="lp-cn-round" data-judge="true">
                  <span className="lp-cn-round-num">3</span>
                  <div className="lp-cn-round-body">
                    <span className="lp-cn-round-name">Judge</span>
                    <span className="lp-cn-round-desc">
                      The Judge accepts, rejects or merges every recommendation and
                      outputs the final strategy.
                    </span>
                  </div>
                </div>
              </div>

              <p className="lp-cn-note">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 12 2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>
                Swap any model per role. Nothing is hardcoded.
              </p>
            </div>
          </div>
        </section>

        {/* ===== section: sc ===== */}
        <section id="scoring" className="lp-sc">
          <div className="lp-sc-inner">
            <div className="lp-sc-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("The publish gate")}
                <span className="lp-eyebrow-tag">8-score</span>
              </span>
              <h2 className="lp-sc-title">
                {t("Scoring & the")} <span className="lp-sc-grad">{t("publish gate")}</span>
              </h2>
              <p className="lp-sc-sub">
                {t("Every draft is graded on eight independent surfaces before it earns the right to ship. One combined gate decides: publish, or back to the editor and the council.")}
              </p>
            </div>

            <div className="lp-sc-layout">
              <div className="lp-sc-grid">
                {[
                  { key: "SEO", measures: "Keyword and intent, headings, links, entities", target: "≥ 85", value: 91, threshold: 85 },
                  { key: "AEO", measures: "Answer blocks, FAQs, snippet-ready structure", target: "≥ 85", value: 88, threshold: 85 },
                  { key: "GEO", measures: "Entity clarity and citation readiness for AI engines", target: "≥ 80", value: 84, threshold: 80 },
                  { key: "HEO", measures: "Human tone, usefulness, and flow", target: "≥ 85", value: 90, threshold: 85 },
                  { key: "EEAT", measures: "Experience, expertise, authority, trust", target: "≥ 80", value: 86, threshold: 80 },
                  { key: "Fact", measures: "Claim accuracy and source reliability", target: "> 80", value: 93, threshold: 80 },
                  { key: "Spam Risk", measures: "Stuffing and unsupported risk. Lower is better.", target: "< 25", value: 12, threshold: 25, invert: true },
                  { key: "Publish", measures: "Combined gate score across all surfaces", target: "≥ 85", value: 87, threshold: 85, gate: true },
                ].map((s) => {
                  const pass = s.invert ? s.value < s.threshold : s.value >= s.threshold;
                  return (
                    <div
                      key={s.key}
                      className={"lp-sc-card" + (s.gate ? " lp-sc-card-gate" : "")}
                    >
                      <div className="lp-sc-card-top">
                        <span className="lp-sc-label">{s.key}</span>
                        <span className={"lp-sc-val" + (s.invert ? " lp-sc-val-risk" : "")}>
                          {s.value}
                        </span>
                      </div>
                      <p className="lp-sc-measures">{s.measures}</p>
                      <div
                        className="lp-sc-bar"
                        role="img"
                        aria-label={s.key + " score " + s.value + ", target " + s.target + ", " + (pass ? "pass" : "below gate")}
                      >
                        <span
                          className={"lp-sc-fill" + (s.invert ? " lp-sc-fill-risk" : "") + (s.gate ? " lp-sc-fill-gate" : "")}
                          style={{ width: s.value + "%" }}
                        />
                        <span
                          className="lp-sc-tick"
                          style={{ left: s.threshold + "%" }}
                          aria-hidden="true"
                        />
                      </div>
                      <div className="lp-sc-card-foot">
                        <span className="lp-sc-target-lbl">{s.invert ? "Ceiling" : "Gate"}</span>
                        <span className="lp-sc-target">{s.target}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <aside className="lp-sc-gate">
                <div className="lp-sc-gate-head">
                  <span className="lp-sc-gate-eyebrow">Publish gate</span>
                  <span className="lp-sc-badge">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    PASS
                  </span>
                </div>

                <div className="lp-sc-ring-wrap">
                  <div className="lp-sc-ring" style={{ "--pct": "87" } as React.CSSProperties}>
                    <div className="lp-sc-ring-core">
                      <span className="lp-sc-ring-label">Publish</span>
                      <span className="lp-sc-ring-num">87</span>
                      <span className="lp-sc-ring-of">gate &#8805; 85</span>
                    </div>
                  </div>
                </div>

                <ul className="lp-sc-rules">
                  <li className="lp-sc-rule">
                    <span className="lp-sc-rule-ico lp-sc-rule-ok" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    <span>Publish score <strong>&#8805; 85</strong></span>
                  </li>
                  <li className="lp-sc-rule">
                    <span className="lp-sc-rule-ico lp-sc-rule-ok" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    <span>Fact score <strong>&gt; 80</strong></span>
                  </li>
                  <li className="lp-sc-rule">
                    <span className="lp-sc-rule-ico lp-sc-rule-ok" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    <span><strong>Zero</strong> high-risk unsupported claims</span>
                  </li>
                </ul>

                <p className="lp-sc-gate-note">
                  Ready only when all three hold. Anything below returns to the editor
                  <span className="lp-sc-warn-chip">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
                    below gate
                  </span>
                  {" "}or the council.
                </p>
              </aside>
            </div>
          </div>
        </section>

        {/* ===== section: publish & integrations ===== */}
        <section id="publish" className="lp-pub">
          <div className="lp-pub-inner">
            <div className="lp-pub-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("Ship it")}
              </span>
              <h2 className="lp-pub-title">
                {t("Content ready.")}{" "}
                <span className="lp-pub-grad">{t("Publish anywhere")}</span> {t("in one click.")}
              </h2>
              <p className="lp-pub-sub">
                {t("Connect your site once, then push the finished draft straight to WordPress as clean Gutenberg blocks, schedule it, or export to any format. No copy-paste, no reformatting.")}
              </p>
            </div>

            <div className="lp-pub-grid">
              <ul className="lp-pub-feats">
                <li>
                  <span className="lp-pub-fico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12a4 4 0 0 1 4-4h4a4 4 0 0 1 0 8h-2" /><path d="M15 12a4 4 0 0 1-4 4H7a4 4 0 0 1 0-8h2" /></svg>
                  </span>
                  <div>
                    <b>Connect once</b>
                    <span>OAuth or a WordPress application password. Reuse across every project.</span>
                  </div>
                </li>
                <li>
                  <span className="lp-pub-fico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5" /></svg>
                  </span>
                  <div>
                    <b>Clean Gutenberg blocks</b>
                    <span>RankMath or Yoast fields, categories and featured image mapped automatically.</span>
                  </div>
                </li>
                <li>
                  <span className="lp-pub-fico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                  </span>
                  <div>
                    <b>Publish now or schedule</b>
                    <span>Go live instantly, or queue it for the perfect slot.</span>
                  </div>
                </li>
                <li>
                  <span className="lp-pub-fico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></svg>
                  </span>
                  <div>
                    <b>Export anywhere</b>
                    <span>Markdown, HTML, DOCX, Google Docs and JSON-LD schema, one click each.</span>
                  </div>
                </li>
              </ul>

              <div className="lp-pub-card">
                <div className="lp-pub-card-head">
                  <span className="lp-pub-card-title">Publish</span>
                  <span className="lp-pub-ready">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                    Gate passed
                  </span>
                </div>

                <div className="lp-pub-conn">
                  <span className="lp-pub-conn-logo" data-p="wp" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M12 0C5.385 0 0 5.385 0 12s5.385 12 12 12 12-5.385 12-12S18.615 0 12 0zM1.211 12c0-1.564.336-3.05.935-4.39l5.15 14.107C3.694 19.966 1.211 16.273 1.211 12zM12 22.789c-1.06 0-2.081-.153-3.048-.437l3.237-9.406 3.315 9.087a1.05 1.05 0 0 0 .078.149A10.74 10.74 0 0 1 12 22.789zm1.488-15.85c.65-.034 1.235-.102 1.235-.102.582-.069.513-.922-.069-.888 0 0-1.749.137-2.878.137-1.061 0-2.844-.137-2.844-.137-.582-.034-.65.854-.069.888 0 0 .551.068 1.132.102l1.68 4.605-2.362 7.08-3.929-11.685c.65-.034 1.235-.102 1.235-.102.582-.069.513-.922-.069-.888 0 0-1.749.137-2.878.137-.202 0-.442-.005-.696-.014C4.911 3.116 8.235 1.211 12 1.211c2.804 0 5.356 1.072 7.275 2.826-.046-.003-.092-.009-.14-.009-1.06 0-1.812.923-1.812 1.914 0 .89.513 1.643 1.06 2.531.411.72.89 1.643.89 2.977 0 .925-.354 1.999-.821 3.494l-1.075 3.591-3.898-11.596zm7.581 4.404l.011.011a10.72 10.72 0 0 1-2.706 8.99l3.295-9.527c.616-1.539.82-2.771.82-3.866 0-.397-.026-.766-.073-1.109a10.71 10.71 0 0 1 1.324 5.155c0 .112-.004.223-.006.334z" /></svg>
                  </span>
                  <div className="lp-pub-conn-meta">
                    <span className="lp-pub-conn-site">spicyranked.com</span>
                    <span className="lp-pub-conn-status">
                      <i className="lp-pub-conn-dot" /> WordPress · Connected
                    </span>
                  </div>
                  <span className="lp-pub-conn-tag">Change</span>
                </div>

                <div className="lp-pub-fields">
                  <span>Gutenberg blocks</span>
                  <span>RankMath mapped</span>
                  <span>Featured image</span>
                  <span>Category · Reviews</span>
                </div>

                <div className="lp-pub-actions">
                  <span className="lp-pub-go">
                    Publish now
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
                  </span>
                  <span className="lp-pub-sched">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                    Schedule
                  </span>
                </div>
              </div>
            </div>

            <div className="lp-pub-platforms">
              <span className="lp-pub-platforms-label">Publish &amp; export to</span>
              <div className="lp-pub-plats">
                <span className="lp-pub-plat" data-p="wp">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 0C5.385 0 0 5.385 0 12s5.385 12 12 12 12-5.385 12-12S18.615 0 12 0zM1.211 12c0-1.564.336-3.05.935-4.39l5.15 14.107C3.694 19.966 1.211 16.273 1.211 12zM12 22.789c-1.06 0-2.081-.153-3.048-.437l3.237-9.406 3.315 9.087a1.05 1.05 0 0 0 .078.149A10.74 10.74 0 0 1 12 22.789zm1.488-15.85c.65-.034 1.235-.102 1.235-.102.582-.069.513-.922-.069-.888 0 0-1.749.137-2.878.137-1.061 0-2.844-.137-2.844-.137-.582-.034-.65.854-.069.888 0 0 .551.068 1.132.102l1.68 4.605-2.362 7.08-3.929-11.685c.65-.034 1.235-.102 1.235-.102.582-.069.513-.922-.069-.888 0 0-1.749.137-2.878.137-.202 0-.442-.005-.696-.014C4.911 3.116 8.235 1.211 12 1.211c2.804 0 5.356 1.072 7.275 2.826-.046-.003-.092-.009-.14-.009-1.06 0-1.812.923-1.812 1.914 0 .89.513 1.643 1.06 2.531.411.72.89 1.643.89 2.977 0 .925-.354 1.999-.821 3.494l-1.075 3.591-3.898-11.596zm7.581 4.404l.011.011a10.72 10.72 0 0 1-2.706 8.99l3.295-9.527c.616-1.539.82-2.771.82-3.866 0-.397-.026-.766-.073-1.109a10.71 10.71 0 0 1 1.324 5.155c0 .112-.004.223-.006.334z" /></svg>
                  WordPress
                </span>
                <span className="lp-pub-plat">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M8.5 13h7M8.5 16.5h7" /></svg>
                  Google Docs
                </span>
                <span className="lp-pub-plat">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M22.27 19.385H1.73A1.73 1.73 0 0 1 0 17.655V6.345a1.73 1.73 0 0 1 1.73-1.73h20.54A1.73 1.73 0 0 1 24 6.345v11.31a1.73 1.73 0 0 1-1.73 1.73zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z" /></svg>
                  Markdown
                </span>
                <span className="lp-pub-plat">
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 5l-4 14" /></svg>
                  HTML
                </span>
                <span className="lp-pub-plat">
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
                  DOCX
                </span>
                <span className="lp-pub-plat">
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 4H7a3 3 0 0 0-3 3v2a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2a3 3 0 0 0 3 3h1M16 4h1a3 3 0 0 1 3 3v2a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2a3 3 0 0 1-3 3h-1" /></svg>
                  JSON-LD
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ===== section: pr ===== */}
        <section id="pricing" className="lp-pr">
          <div className="lp-pr-inner">
            <div className="lp-pr-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("Pricing")}
                <span className="lp-eyebrow-tag">Credits</span>
              </span>
              <h2 className="lp-pr-title">
                {t("Start free.")} <span className="lp-pr-grad">{t("Scale when you rank.")}</span>
              </h2>
              <p className="lp-pr-sub">
                {t("Credits meter every model call and every score. Begin on mock providers with zero API spend, then plug in your own keys and publish once the 8-score gate clears.")}
              </p>
            </div>

            <div className="lp-pr-grid">
              {/* Free */}
              <div className="lp-pr-card lp-rise">
                <div className="lp-pr-card-top">
                  <span className="lp-pr-plan">Free</span>
                  <p className="lp-pr-plan-note">For a first project</p>
                </div>
                <div className="lp-pr-price">
                  <span className="lp-pr-amt">$0</span>
                  <span className="lp-pr-per">/mo</span>
                </div>
                <div className="lp-pr-credits">
                  <span className="lp-pr-credits-num">500 credits</span>
                  <span className="lp-pr-credits-lbl">/ mo</span>
                </div>
                <a href="#get-started" className="lp-btn-ghost lp-pr-cta">Start free</a>
                <ul className="lp-pr-feats">
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    1 active project
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Mock providers, zero API spend
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Markdown &amp; HTML export
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Community support
                  </li>
                </ul>
              </div>

              {/* Pro, most popular */}
              <div className="lp-pr-card lp-pr-card--pop lp-rise">
                <span className="lp-pr-badge">Most popular</span>
                <div className="lp-pr-card-top">
                  <span className="lp-pr-plan">Pro</span>
                  <p className="lp-pr-plan-note">For operators shipping weekly</p>
                </div>
                <div className="lp-pr-price">
                  <span className="lp-pr-amt">$29</span>
                  <span className="lp-pr-per">/mo</span>
                </div>
                <div className="lp-pr-credits">
                  <span className="lp-pr-credits-num">5,000 credits</span>
                  <span className="lp-pr-credits-lbl">/ mo</span>
                </div>
                <a href="#get-started" className="lp-btn-primary lp-pr-cta">Upgrade to Pro</a>
                <ul className="lp-pr-feats">
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Unlimited projects
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Bring your own AI keys
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    One-click WordPress publishing
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Priority council routing
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    All 8 scores plus fact-check
                  </li>
                </ul>
              </div>

              {/* Business */}
              <div className="lp-pr-card lp-rise">
                <div className="lp-pr-card-top">
                  <span className="lp-pr-plan">Business</span>
                  <p className="lp-pr-plan-note">For multi-site teams</p>
                </div>
                <div className="lp-pr-price">
                  <span className="lp-pr-amt">$99</span>
                  <span className="lp-pr-per">/mo</span>
                </div>
                <div className="lp-pr-credits">
                  <span className="lp-pr-credits-num">25,000 credits</span>
                  <span className="lp-pr-credits-lbl">/ mo</span>
                </div>
                <a href="#get-started" className="lp-btn-ghost lp-pr-cta">Upgrade to Business</a>
                <ul className="lp-pr-feats">
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Everything in Pro
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Team seats &amp; roles
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Custom house rules
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Restricted-niche routing
                  </li>
                  <li className="lp-pr-feat">
                    <span className="lp-pr-check" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    Full API access
                  </li>
                </ul>
              </div>
            </div>

            <p className="lp-pr-reassure fade-in">
              <span className="lp-pr-reassure-dot" aria-hidden="true" />
              Credits meter usage transparently. No card required to start.
            </p>
          </div>
        </section>

        {/* ===== section: faq ===== */}
        <section className="lp-faq">
          <div className="lp-faq-inner">
            <div className="lp-faq-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("FAQ")}
              </span>
              <h2 className="lp-faq-title">
                {t("Questions, resolved by")}{" "}
                <span className="lp-faq-grad">{t("the same rigor")}</span> {t("we apply to every article")}
              </h2>
              <p className="lp-faq-sub">
                {t("Four models, a Judge, a fact-check gate and one-click publishing. Here is exactly how ContentOS holds up under scrutiny.")}
              </p>
            </div>

            <div className="lp-faq-list fade-in">
              <details className="lp-faq-item" open>
                <summary className="lp-faq-q">
                  <span className="lp-faq-q-text">How is this different from ChatGPT or Jasper?</span>
                  <span className="lp-faq-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </summary>
                <div className="lp-faq-a">
                  <p>
                    Those are one model with one perspective and one detectable voice. ContentOS
                    runs four models that debate, a Judge that resolves conflicts with reasons
                    you can override, and a fact-check plus 8-score gate before anything publishes.
                  </p>
                </div>
              </details>

              <details className="lp-faq-item">
                <summary className="lp-faq-q">
                  <span className="lp-faq-q-text">How does the four-model council actually work?</span>
                  <span className="lp-faq-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </summary>
                <div className="lp-faq-a">
                  <p>
                    Round 1: OpenAI, Claude, Gemini and Grok each produce recommendations in
                    parallel, with confidence. Round 2: they challenge each other and surface the
                    real conflicts. Round 3: a Judge accepts, rejects or merges every point and
                    outputs the final strategy, with a reason you can override.
                  </p>
                </div>
              </details>

              <details className="lp-faq-item">
                <summary className="lp-faq-q">
                  <span className="lp-faq-q-text">Does it stop AI hallucinations?</span>
                  <span className="lp-faq-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </summary>
                <div className="lp-faq-a">
                  <p>
                    A fact checker extracts every claim, attaches a source, a confidence and a
                    risk level, then blocks publish on any high-risk unsupported claim. Nothing
                    ships until the 8-score gate is met across all four search surfaces.
                  </p>
                </div>
              </details>

              <details className="lp-faq-item">
                <summary className="lp-faq-q">
                  <span className="lp-faq-q-text">Can it write for restricted or adult-adjacent niches?</span>
                  <span className="lp-faq-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </summary>
                <div className="lp-faq-a">
                  <p>
                    Yes. Policy-tier routing sends restricted topics to permissive providers
                    automatically, with failover. You get no refusals and no diluted output, which
                    is exactly what mainstream tools will not do.
                  </p>
                </div>
              </details>

              <details className="lp-faq-item">
                <summary className="lp-faq-q">
                  <span className="lp-faq-q-text">How does publishing work?</span>
                  <span className="lp-faq-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </summary>
                <div className="lp-faq-a">
                  <p>
                    One click to WordPress as Gutenberg blocks, with RankMath or Yoast field
                    mapping. You can also export Markdown, HTML, Google Docs and JSON-LD.
                  </p>
                </div>
              </details>

              <details className="lp-faq-item">
                <summary className="lp-faq-q">
                  <span className="lp-faq-q-text">What are credits, and can I use my own API keys?</span>
                  <span className="lp-faq-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </summary>
                <div className="lp-faq-a">
                  <p>
                    Credits meter model usage. Blank keys fall back to a free mock adapter, and
                    Pro and above let you bring your own provider keys with per-article and
                    monthly cost caps.
                  </p>
                </div>
              </details>
            </div>
          </div>
        </section>

        {/* ===== section: cta2 ===== */}
        <section className="lp-cta2">
          <div className="lp-cta2-inner">
            <div className="lp-cta2-panel lp-cta2-reveal">
              <div className="lp-cta2-glow" aria-hidden="true" />
              <div className="lp-cta2-grid" aria-hidden="true" />

              <div className="lp-cta2-content">
                <span className="lp-eyebrow">
                  <span className="lp-eyebrow-dot" />
                  READY WHEN YOU ARE
                  <span className="lp-eyebrow-tag">v1</span>
                </span>

                <h2 className="lp-cta2-title">
                  Four minds. One judge.{" "}
                  <span className="lp-cta2-grad">Content that earns its rank.</span>
                </h2>

                <p className="lp-cta2-sub">
                  One brief, debated across OpenAI, Claude, Gemini and Grok, fact-checked and
                  gated at score 8, then exported to WordPress in a click.
                </p>

                <div className="lp-cta2-actions">
                  <a className="lp-btn-primary" href="/chat">
                    Start writing free
                    <svg
                      className="lp-cta2-arrow"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 12h14" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </a>
                  <a className="lp-btn-ghost" href="#how">
                    See how it works
                  </a>
                </div>

                <p className="lp-cta2-trust">
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                  No card to start
                  <span className="lp-cta2-dot" aria-hidden="true">·</span>
                  Runs free on mock providers
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ===== section: ft ===== */}
        <footer className="lp-ft">
          <div className="lp-ft-inner">
            <div className="lp-ft-cta fade-in">
              <div className="lp-ft-cta-copy">
                <span className="lp-eyebrow">
                  <span className="lp-eyebrow-dot" />
                  GET STARTED
                  <span className="lp-eyebrow-tag">FREE BRIEF</span>
                </span>
                <h2 className="lp-ft-cta-title">
                  One brief. Four models.{" "}
                  <span className="lp-ft-cta-grad">Publish-ready in minutes.</span>
                </h2>
                <p className="lp-ft-cta-sub">
                  Run a single brief through OpenAI, Claude, Gemini and Grok at once,
                  let the Judge resolve every conflict, and export to WordPress in one click.
                </p>
              </div>
              <div className="lp-ft-cta-actions">
                <a className="lp-btn-primary" href="#pricing">Start free</a>
                <a className="lp-btn-ghost" href="#how">See how it works</a>
              </div>
            </div>

            <div className="lp-ft-top">
              <div className="lp-ft-brand">
                <a href="#" className="lp-ft-logo" aria-label="ContentOS AI home">
                  <span className="lp-ft-mark" aria-hidden="true">C</span>
                  <span className="lp-ft-name">
                    ContentOS<span className="lp-ft-name-ai">AI</span>
                  </span>
                </a>
                <p className="lp-ft-tagline">
                  The multi-model content engine. A council of AIs debates, a Judge decides,
                  and every article passes an 8-score gate before it ships.
                </p>
                <div className="lp-ft-social" aria-label="Social links">
                  <a className="lp-ft-social-link" href="#" aria-label="ContentOS AI on X">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 4l16 16" />
                      <path d="M20 4L4 20" />
                    </svg>
                  </a>
                  <a className="lp-ft-social-link" href="#" aria-label="ContentOS AI on GitHub">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M15 22v-4a3 3 0 0 0-.9-2.3c3-.3 6.1-1.5 6.1-6.6a5.1 5.1 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.1-.3-3.7 1.4a12.6 12.6 0 0 0-6.6 0C6.3 1.7 5.2 2 5.2 2a4.8 4.8 0 0 0-.1 3.6A5.1 5.1 0 0 0 3.7 9.2c0 5.1 3.1 6.3 6.1 6.6A3 3 0 0 0 9 18v4" />
                      <path d="M9 19c-4 1.4-4-1.8-6-2" />
                    </svg>
                  </a>
                  <a className="lp-ft-social-link" href="#" aria-label="ContentOS AI on LinkedIn">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="3" width="18" height="18" rx="3" />
                      <path d="M7 10v7" />
                      <path d="M7 7.01V7" />
                      <path d="M11 17v-4a2 2 0 0 1 4 0v4" />
                      <path d="M11 17v-7" />
                    </svg>
                  </a>
                </div>
              </div>

              <nav className="lp-ft-cols" aria-label="Footer">
                <div className="lp-ft-col">
                  <h3 className="lp-ft-col-title">Product</h3>
                  <ul className="lp-ft-list">
                    <li><a className="lp-ft-link" href="#how">How it works</a></li>
                    <li><a className="lp-ft-link" href="#council">The Council</a></li>
                    <li><a className="lp-ft-link" href="#scoring">Scoring gate</a></li>
                    <li><a className="lp-ft-link" href="#export">WordPress export</a></li>
                    <li><a className="lp-ft-link" href="#pricing">Pricing</a></li>
                  </ul>
                </div>

                <div className="lp-ft-col">
                  <h3 className="lp-ft-col-title">Company</h3>
                  <ul className="lp-ft-list">
                    <li><a className="lp-ft-link" href="#">About</a></li>
                    <li><a className="lp-ft-link" href="#">Careers</a></li>
                    <li><a className="lp-ft-link" href="#">Contact</a></li>
                  </ul>
                </div>

                <div className="lp-ft-col">
                  <h3 className="lp-ft-col-title">Resources</h3>
                  <ul className="lp-ft-list">
                    <li><a className="lp-ft-link" href="#">Docs</a></li>
                    <li><a className="lp-ft-link" href="#">Blog</a></li>
                    <li><a className="lp-ft-link" href="#">Changelog</a></li>
                    <li>
                      <a className="lp-ft-link lp-ft-link-status" href="#">
                        Status
                        <span className="lp-ft-status-dot" aria-hidden="true" />
                        <span className="lp-ft-status-label">All systems normal</span>
                      </a>
                    </li>
                  </ul>
                </div>

                <div className="lp-ft-col">
                  <h3 className="lp-ft-col-title">Legal</h3>
                  <ul className="lp-ft-list">
                    <li><a className="lp-ft-link" href="#">Privacy</a></li>
                    <li><a className="lp-ft-link" href="#">Terms</a></li>
                    <li><a className="lp-ft-link" href="#">Security</a></li>
                    <li><a className="lp-ft-link" href="#">Acceptable use</a></li>
                  </ul>
                </div>
              </nav>
            </div>

            <div className="lp-ft-bottom">
              <p className="lp-ft-copy">© 2026 ContentOS AI. Built by Tech Savy Crew.</p>
              <ul className="lp-ft-legal">
                <li><a className="lp-ft-legal-link" href="#">Privacy</a></li>
                <li aria-hidden="true" className="lp-ft-legal-sep">·</li>
                <li><a className="lp-ft-legal-link" href="#">Terms</a></li>
                <li aria-hidden="true" className="lp-ft-legal-sep">·</li>
                <li><a className="lp-ft-legal-link" href="#">Status</a></li>
              </ul>
            </div>
          </div>
        </footer>

      </main>
    </>
  );
}

const HOW_STEPS = [
  {
    n: "01",
    side: "up",
    title: "Brief in",
    desc: "Topic, keyword, audience, tone and goal. One line is all it takes to start the line.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h10M4 18h7" /></svg>
    ),
    visual: (
      <div className="lp-how-vis lp-how-vis-brief">
        <span className="lp-how-vlabel">New brief</span>
        <div className="lp-how-field">
          feetfinder review 2026<i className="lp-how-caret" />
        </div>
        <div className="lp-how-metarow">
          <span>kw · feetfinder reviews</span>
          <span>US</span>
          <span>we-not-I</span>
        </div>
        <span className="lp-how-run">
          Convene the council
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
        </span>
      </div>
    ),
  },
  {
    n: "02",
    side: "down",
    title: "Research Intelligence",
    desc: "SERP, competitor H2s, People-Also-Ask, entities and trusted citations, with search intent detected.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
    ),
    visual: (
      <div className="lp-how-vis lp-how-vis-radar">
        <span className="lp-how-vlabel">Research intelligence</span>
        <div className="lp-how-scans">
          <span className="lp-how-scan" />
          <span className="lp-how-scan" />
          <span className="lp-how-scan" />
          <span className="lp-how-scan" />
          <span className="lp-how-scan" />
        </div>
        <div className="lp-how-chiprow">
          <span className="lp-how-tag">intent · commercial</span>
          <span className="lp-how-pill">24 entities</span>
        </div>
        <div className="lp-how-srcs">
          <span>Trustpilot</span>
          <span>Reddit</span>
          <span>SERP ×10</span>
        </div>
      </div>
    ),
  },
  {
    n: "03",
    side: "up",
    title: "Council debate",
    desc: "Four role-based models run in parallel, then challenge each other. Conflicts are surfaced, not hidden.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 10h8M8 14h5" /><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2Z" /></svg>
    ),
    visual: (
      <div className="lp-how-vis lp-how-vis-council">
        <span className="lp-how-vlabel">Four-model debate</span>
        <div className="lp-how-seats">
          <div className="lp-how-seatrow" data-p="openai">
            <span className="lp-how-av">O</span>
            <span className="lp-how-seatname">OpenAI</span>
            <span className="lp-how-conf"><i style={{ width: "92%" }} /></span>
          </div>
          <div className="lp-how-seatrow" data-p="anthropic">
            <span className="lp-how-av">A</span>
            <span className="lp-how-seatname">Claude</span>
            <span className="lp-how-conf"><i style={{ width: "88%" }} /></span>
          </div>
          <div className="lp-how-seatrow" data-p="google">
            <span className="lp-how-av">G</span>
            <span className="lp-how-seatname">Gemini</span>
            <span className="lp-how-conf"><i style={{ width: "90%" }} /></span>
          </div>
          <div className="lp-how-seatrow" data-p="xai">
            <span className="lp-how-av">X</span>
            <span className="lp-how-seatname">Grok</span>
            <span className="lp-how-conf"><i style={{ width: "84%" }} /></span>
          </div>
        </div>
        <span className="lp-how-tag lp-how-tag-conflict">1 conflict surfaced</span>
      </div>
    ),
  },
  {
    n: "04",
    side: "down",
    title: "Judge decides",
    desc: "Accept, reject, merge or need-evidence on every point, each with a reason you can override.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18M7 8l-4 6h8L7 8ZM17 8l-4 6h8l-4-6ZM5 21h14" /></svg>
    ),
    visual: (
      <div className="lp-how-vis lp-how-vis-verdicts">
        <span className="lp-how-vlabel">Judge decisions</span>
        <div className="lp-how-verdict ok">
          <b>Accepted</b>
          <span>20% fee, sourced</span>
        </div>
        <div className="lp-how-verdict rej">
          <b>Rejected</b>
          <span>“safest platform”</span>
        </div>
        <div className="lp-how-verdict merge">
          <b>Merge</b>
          <span>payout-trust section</span>
        </div>
      </div>
    ),
  },
  {
    n: "05",
    side: "up",
    title: "Outline + Draft",
    desc: "Approved strategy becomes H1/H2/H3, then a section-by-section article. House rules enforced.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M4 4h13M4 10h9" /><path d="m14 18 3-3 3 3-3 3-3-3Z" /></svg>
    ),
    visual: (
      <div className="lp-how-vis lp-how-vis-outline">
        <span className="lp-how-vlabel">Outline + draft</span>
        <div className="lp-how-tree">
          <span className="lp-how-node h1">H1 · Quick verdict</span>
          <span className="lp-how-node h2">H2<i /></span>
          <span className="lp-how-node h3">H3<i /></span>
          <span className="lp-how-node h2">H2<i /></span>
        </div>
        <div className="lp-how-elems">
          <span>Table</span>
          <span>FAQ</span>
          <span>CTA</span>
        </div>
      </div>
    ),
  },
  {
    n: "06",
    side: "down",
    title: "Score + Publish gate",
    desc: "Eight scores, every claim sourced. Gate needs Publish 85+, Fact 80+, zero high-risk. Then one-click WordPress.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 12 2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>
    ),
    visual: (
      <div className="lp-how-vis lp-how-vis-gate">
        <span className="lp-how-vlabel">Publish gate</span>
        <div className="lp-how-gate-main">
          <span className="lp-how-ring"><b>88</b><small>Publish</small></span>
          <div className="lp-how-bars">
            <div className="lp-how-bar"><span>SEO</span><i><em style={{ width: "88%" }} /></i><b>88</b></div>
            <div className="lp-how-bar"><span>AEO</span><i><em style={{ width: "86%" }} /></i><b>86</b></div>
            <div className="lp-how-bar"><span>GEO</span><i><em style={{ width: "82%" }} /></i><b>82</b></div>
            <div className="lp-how-bar"><span>HEO</span><i><em style={{ width: "87%" }} /></i><b>87</b></div>
          </div>
        </div>
        <span className="lp-how-gatechip"><i className="lp-how-check">✓</i>Gate passed · 0 high-risk</span>
      </div>
    ),
  },
];
