"use client";

import Link from "next/link";
import { useState } from "react";
import LandingHeader from "../../components/LandingHeader";
import MarketingFooter from "../../components/MarketingFooter";
import { useLang } from "../../lib/i18n";
import {
  ANNUAL_MONTHS_BILLED,
  BASE_RUN_CREDITS,
  COMPARISON,
  CREDIT_EXAMPLES,
  DEFAULT_WORDS,
  PAYMENTS_ENABLED,
  PLANS,
  PRICING_FAQ,
  WORDS_PER_CREDIT,
  annualPerMonth,
  annualTotal,
  articlesPerMonth,
  runCredits,
  type Cell,
} from "../../lib/pricing";

const num = (n: number) => n.toLocaleString("en-US");

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export default function PricingPage() {
  const { t } = useLang();
  const [annual, setAnnual] = useState(false);

  // A comparison cell is either a yes/no mark or a short literal value.
  const renderCell = (v: Cell) => {
    if (v === true) {
      return (
        <span className="pp-yes" role="img" aria-label={t("Included")}>
          <CheckIcon />
        </span>
      );
    }
    if (v === false) {
      return <span className="pp-no" role="img" aria-label={t("Not included")} />;
    }
    return <span className="pp-val">{t(v)}</span>;
  };

  return (
    <>
      <LandingHeader />

      <main className="lp pp">
        {/* ===== hero + billing toggle ===== */}
        <section className="pp-hero">
          <div className="pp-hero-fx" aria-hidden="true">
            <span className="lp-orb lp-orb-1" />
            <span className="lp-orb lp-orb-2" />
          </div>

          <div className="pp-inner">
            <div className="pp-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("Pricing")}
                <span className="lp-eyebrow-tag">{t("Credits")}</span>
              </span>
              <h1 className="pp-h1">
                {t("Start free.")}{" "}
                <span className="pp-grad">{t("Scale when you rank.")}</span>
              </h1>
              <p className="pp-lede">
                {t("Credits meter every model call and every score. Begin on mock providers with zero API spend, then plug in your own keys and publish once the 8-score gate clears.")}
              </p>
            </div>

            <div className="pp-toggle-wrap fade-in">
              <div className="pp-toggle" role="group" aria-label={t("Billing period")}>
                <button
                  type="button"
                  className={`pp-toggle-btn ${!annual ? "on" : ""}`}
                  onClick={() => setAnnual(false)}
                  aria-pressed={!annual}
                >
                  {t("Monthly")}
                </button>
                <button
                  type="button"
                  className={`pp-toggle-btn ${annual ? "on" : ""}`}
                  onClick={() => setAnnual(true)}
                  aria-pressed={annual}
                >
                  {t("Annual")}
                  <span className="pp-save">
                    {t("2 months free")}
                  </span>
                </button>
              </div>
            </div>

            {/* ===== plan cards ===== */}
            <div className="lp-pr-grid">
              {PLANS.map((p) => {
                const perMonth = annual ? annualPerMonth(p) : p.monthly;
                const free = p.monthly === 0;
                return (
                  <div
                    key={p.id}
                    className={`lp-pr-card lp-rise${p.popular ? " lp-pr-card--pop" : ""}`}
                  >
                    {p.popular && <span className="lp-pr-badge">{t("Most popular")}</span>}

                    <div className="lp-pr-card-top">
                      <span className="lp-pr-plan">{t(p.name)}</span>
                      <p className="lp-pr-plan-note">{t(p.note)}</p>
                    </div>

                    <div className="lp-pr-price">
                      <span className="lp-pr-amt">${perMonth}</span>
                      <span className="lp-pr-per">/{t("mo")}</span>
                    </div>

                    <p className="pp-billed">
                      {free
                        ? t("Free forever, no card")
                        : annual
                          ? `${t("Billed")} $${num(annualTotal(p))} ${t("a year")}`
                          : t("Billed monthly")}
                    </p>

                    <div className="lp-pr-credits">
                      <span className="lp-pr-credits-num">
                        {num(p.credits)} {t("credits")}
                      </span>
                      <span className="lp-pr-credits-lbl">/ {t("mo")}</span>
                    </div>

                    <p className="pp-articles">
                      {t("About")} <b>{num(articlesPerMonth(p))}</b>{" "}
                      {t("articles a month")}
                    </p>

                    {free || PAYMENTS_ENABLED ? (
                      <Link
                        href="/signup"
                        className={`${p.popular ? "lp-btn-primary" : "lp-btn-ghost"} lp-pr-cta`}
                      >
                        {t(p.cta)}
                      </Link>
                    ) : (
                      <span className="lp-btn-ghost lp-pr-cta pp-soon" aria-disabled="true">
                        {t("Coming soon")}
                      </span>
                    )}

                    <ul className="lp-pr-feats">
                      {p.features.map((f) => (
                        <li className="lp-pr-feat" key={f}>
                          <span className="lp-pr-check" aria-hidden="true">
                            <CheckIcon />
                          </span>
                          {t(f)}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>

            <p className="lp-pr-reassure fade-in">
              <span className="lp-pr-reassure-dot" aria-hidden="true" />
              {t("Credits meter usage transparently. No card required to start.")}
            </p>
          </div>
        </section>

        {/* ===== how credits work ===== */}
        <section className="pp-credits">
          <div className="pp-inner">
            <div className="pp-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("How credits work")}
              </span>
              <h2 className="pp-h2">
                {t("You are charged before a model runs,")}{" "}
                <span className="pp-grad">{t("never after")}</span>
              </h2>
              <p className="pp-sub">
                {t("One credit is about one US cent of budgeted model spend. Every run is estimated and charged up front from your target length, so an empty balance stops the run before a single provider call — there is no surprise bill.")}
              </p>
            </div>

            <div className="pp-credits-grid">
              <div className="pp-formula">
                <span className="pp-formula-label">{t("Cost of one run")}</span>
                <div className="pp-formula-row">
                  <span className="pp-formula-term">{BASE_RUN_CREDITS}</span>
                  <span className="pp-formula-op">+</span>
                  <span className="pp-formula-term">
                    {t("words")} ÷ {WORDS_PER_CREDIT}
                  </span>
                  <span className="pp-formula-op">=</span>
                  <span className="pp-formula-out">{t("credits")}</span>
                </div>
                <p className="pp-formula-note">
                  {t("A base charge covers research, the four-model council and scoring; the rest scales with how long the article is.")}
                </p>
              </div>

              <div className="pp-ex">
                <span className="pp-ex-title">{t("What that looks like")}</span>
                {CREDIT_EXAMPLES.map((e) => (
                  <div className="pp-ex-row" key={e.words}>
                    <span className="pp-ex-label">{t(e.label)}</span>
                    <span className="pp-ex-words">
                      {num(e.words)} {t("words")}
                    </span>
                    <span className="pp-ex-credits">
                      {e.credits} {t("credits")}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="pp-buys">
              {PLANS.map((p) => (
                <div className="pp-buy" key={p.id}>
                  <span className="pp-buy-n">
                    ~{num(articlesPerMonth(p))}
                  </span>
                  <span className="pp-buy-l">
                    {t("articles a month on")} {t(p.name)}
                  </span>
                  <span className="pp-buy-sub">
                    {num(p.credits)} {t("credits")} ÷ {runCredits()}{" "}
                    {t("per")} {num(DEFAULT_WORDS)}-{t("word article")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== comparison table ===== */}
        <section className="pp-cmp">
          <div className="pp-inner">
            <div className="pp-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("Compare plans")}
              </span>
              <h2 className="pp-h2">
                {t("Every feature,")}{" "}
                <span className="pp-grad">{t("side by side")}</span>
              </h2>
            </div>

            <div className="pp-table-wrap">
              <table className="pp-table">
                <caption className="sr-only">
                  {t("Feature comparison across the Free, Pro and Business plans")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="pp-table-feat">{t("Feature")}</th>
                    {PLANS.map((p) => (
                      <th
                        scope="col"
                        key={p.id}
                        className={p.popular ? "pp-col-pop" : ""}
                      >
                        {t(p.name)}
                        {p.popular && (
                          <span className="pp-col-tag">{t("Popular")}</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>

                {COMPARISON.map((g) => (
                  <tbody key={g.group}>
                    <tr className="pp-table-grouprow">
                      <th scope="colgroup" colSpan={4}>{t(g.group)}</th>
                    </tr>
                    {g.rows.map((r) => (
                      <tr key={r.label}>
                        <th scope="row" className="pp-table-feat">{t(r.label)}</th>
                        <td>{renderCell(r.free)}</td>
                        <td className="pp-col-pop">{renderCell(r.pro)}</td>
                        <td>{renderCell(r.business)}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </div>
        </section>

        {/* ===== pricing FAQ ===== */}
        <section className="pp-faq">
          <div className="pp-inner">
            <div className="pp-head fade-in">
              <span className="lp-eyebrow">
                <span className="lp-eyebrow-dot" />
                {t("Billing FAQ")}
              </span>
              <h2 className="pp-h2">
                {t("Questions about")}{" "}
                <span className="pp-grad">{t("credits and plans")}</span>
              </h2>
            </div>

            <div className="lp-faq-list fade-in">
              {PRICING_FAQ.map((f, i) => (
                <details className="lp-faq-item" key={f.q} open={i === 0}>
                  <summary className="lp-faq-q">
                    <span className="lp-faq-q-text">{t(f.q)}</span>
                    <span className="lp-faq-chevron" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </span>
                  </summary>
                  <div className="lp-faq-a">
                    <p>{t(f.a)}</p>
                  </div>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ===== closing CTA ===== */}
        <section className="pp-cta">
          <div className="pp-inner pp-cta-inner">
            <h2 className="pp-cta-title">
              {t("Run your first brief free")}
            </h2>
            <p className="pp-cta-sub">
              {t("Start with")} {num(PLANS[0].credits)}{" "}
              {t("credits and the whole council — no card, no API spend.")}
            </p>
            <div className="pp-cta-actions">
              <Link href="/signup" className="lp-btn-primary">
                {t("Start free")}
              </Link>
              <Link href="/#how" className="lp-btn-ghost">
                {t("See how it works")}
              </Link>
            </div>
          </div>
        </section>

        <MarketingFooter />
      </main>
    </>
  );
}
