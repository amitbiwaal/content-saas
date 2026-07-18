"use client";

import Link from "next/link";
import LandingHeader from "../../components/LandingHeader";
import MarketingFooter from "../../components/MarketingFooter";
import { useLang } from "../../lib/i18n";

const COUNCIL = [
  { k: "openai", mono: "O", name: "OpenAI", role: "Content Strategist", desc: "Maps search intent and structures the piece." },
  { k: "anthropic", mono: "A", name: "Claude", role: "Human Editor", desc: "Guards tone and flags unsupported claims." },
  { k: "google", mono: "G", name: "Gemini", role: "Search Intelligence", desc: "Extracts entities, answers and fresh sources." },
  { k: "xai", mono: "X", name: "Grok", role: "Trend Analyst", desc: "Surfaces real-time angles and complaints." },
];

const PRINCIPLES = [
  { icon: "⚖", title: "No single-AI bias", body: "One model is one point of view. We run four in parallel, surface their disagreements, and let a Judge resolve them — so no single opinion goes unchecked." },
  { icon: "✋", title: "Human in the loop", body: "The machine proposes; you decide. Every key call is yours to accept, reject, or steer — content ships on your judgment, not a black box's." },
  { icon: "✅", title: "Verifiable, not vibes", body: "Every claim is sourced and fact-checked. Nothing publishes until it clears an eight-score quality gate — SEO, trust, originality and more." },
  { icon: "🔮", title: "Built for AI search", body: "It's not just Google anymore. We optimize for AI Overviews, ChatGPT and Perplexity too, so your work is quotable wherever people ask." },
];

const NUMBERS = [
  { n: "4", label: "frontier models debate every brief" },
  { n: "8", label: "quality scores gate every article" },
  { n: "1", label: "human approves before it ships" },
  { n: "100%", label: "of claims sourced & fact-checked" },
];

export default function AboutPage() {
  const { t } = useLang();
  return (
    <>
      <LandingHeader />
      <main className="lp about">
        {/* Hero */}
        <section className="about-hero">
          <div className="about-hero-fx" aria-hidden="true">
            <span className="lp-orb lp-orb-1" />
            <span className="lp-orb lp-orb-2" />
          </div>
          <div className="about-inner">
            <span className="lp-eyebrow fade-in">
              <span className="lp-eyebrow-dot" />
              {t("OUR MISSION")}
            </span>
            <h1 className="about-h1 fade-in">
              {t("Content the world can trust —")}{" "}
              <span className="about-h1-grad">{t("at machine speed.")}</span>
            </h1>
            <p className="about-lede fade-in">
              {t("AI can write a thousand words in seconds. It can also be confidently wrong, generic, and invisible to search. We built ContentOS so teams get the speed of AI without giving up accuracy, originality, or control.")}
            </p>
            <div className="about-hero-cta fade-in">
              <Link href="/chat" className="lp-btn-primary">{t("Try it free")}</Link>
              <Link href="/#how" className="lp-btn-ghost">{t("See how it works")}</Link>
            </div>
          </div>
        </section>

        {/* Story */}
        <section className="about-story">
          <div className="about-inner about-story-grid">
            <div className="about-story-copy">
              <h2 className="about-h2">{t("Why we built it")}</h2>
              <p>
                {t("Most AI writing tools hand you a single model's first draft and call it done. But one model is one bias — it can't tell you where it's unsure, what it made up, or whether the piece will actually rank.")}
              </p>
              <p>
                {t("So we designed ContentOS as a")} <strong>{t("council, not a chatbot")}</strong>. {t("Four frontier models research and debate the same brief. They challenge each other, and conflicts get surfaced — not hidden. A Judge weighs the arguments, you approve the key decisions, and nothing publishes until it passes an eight-score quality gate. The result: content produced at machine speed that a real team can stand behind.")}
              </p>
            </div>
            <div className="about-story-card">
              <div className="about-flow">
                {["Research the web", "Four models debate", "Judge decides", "You approve", "Score & gate", "Publish"].map((s, i) => (
                  <div className="about-flow-step" key={i}>
                    <span className="about-flow-dot">{i + 1}</span>
                    <span className="about-flow-label">{t(s)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Principles */}
        <section className="about-principles">
          <div className="about-inner">
            <div className="about-section-head">
              <h2 className="about-h2">{t("What we believe")}</h2>
              <p className="about-section-sub">{t("Four principles behind every line ContentOS produces.")}</p>
            </div>
            <div className="about-cards">
              {PRINCIPLES.map((p) => (
                <div className="about-card" key={p.title}>
                  <span className="about-card-ic" aria-hidden="true">{p.icon}</span>
                  <h3 className="about-card-title">{t(p.title)}</h3>
                  <p className="about-card-body">{t(p.body)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* The Council */}
        <section className="about-council">
          <div className="about-inner">
            <div className="about-section-head">
              <h2 className="about-h2">{t("Meet the council")}</h2>
              <p className="about-section-sub">{t("Four frontier models, each with a role. They don't just co-write — they debate.")}</p>
            </div>
            <div className="about-council-grid">
              {COUNCIL.map((c) => (
                <div className={`about-seat tint-${c.k}`} key={c.k}>
                  <span className={`about-seat-av av-${c.k}`}>{c.mono}</span>
                  <div className="about-seat-role">{t(c.role)}</div>
                  <div className="about-seat-name">{c.name}</div>
                  <p className="about-seat-desc">{t(c.desc)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Numbers */}
        <section className="about-numbers">
          <div className="about-inner about-numbers-grid">
            {NUMBERS.map((s) => (
              <div className="about-stat" key={s.label}>
                <div className="about-stat-n">{s.n}</div>
                <div className="about-stat-label">{t(s.label)}</div>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="about-cta">
          <div className="about-inner about-cta-inner">
            <h2 className="about-cta-title">{t("Ready to publish with confidence?")}</h2>
            <p className="about-cta-sub">{t("Run your first brief through the whole council — free.")}</p>
            <div className="about-hero-cta">
              <Link href="/chat" className="lp-btn-primary">{t("Start free")}</Link>
              <Link href="/signup" className="lp-btn-ghost">{t("Create account")}</Link>
            </div>
          </div>
        </section>

        <MarketingFooter />
      </main>
    </>
  );
}
