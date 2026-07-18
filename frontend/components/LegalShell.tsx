"use client";

import LandingHeader from "./LandingHeader";
import MarketingFooter from "./MarketingFooter";
import { useLang } from "../lib/i18n";

export type LegalSection = { id: string; heading: string; paras?: string[]; list?: string[] };

// Shared document layout for legal pages: title + last-updated, a sticky
// on-this-page TOC, and the rendered sections. Theme-aware via tokens.
export default function LegalShell({
  title, updated, intro, sections,
}: {
  title: string;
  updated: string;
  intro?: string;
  sections: LegalSection[];
}) {
  const { t } = useLang();
  return (
    <>
      <LandingHeader />
      <main className="lp legal">
        <div className="legal-head">
          <div className="about-inner">
            <span className="lp-eyebrow"><span className="lp-eyebrow-dot" />{t("LEGAL")}</span>
            <h1 className="legal-title">{t(title)}</h1>
            <p className="legal-updated">{t("Last updated")}: {updated}</p>
          </div>
        </div>

        <div className="about-inner legal-body">
          <aside className="legal-toc">
            <div className="legal-toc-label">{t("On this page")}</div>
            <nav>
              {sections.map((s) => (
                <a key={s.id} href={`#${s.id}`}>{t(s.heading)}</a>
              ))}
            </nav>
          </aside>

          <article className="legal-content">
            {intro && <p className="legal-intro">{t(intro)}</p>}
            {sections.map((s) => (
              <section id={s.id} key={s.id} className="legal-section">
                <h2>{t(s.heading)}</h2>
                {s.paras?.map((p, i) => <p key={i}>{t(p)}</p>)}
                {s.list && (
                  <ul>
                    {s.list.map((li, i) => <li key={i}>{t(li)}</li>)}
                  </ul>
                )}
              </section>
            ))}
            <p className="legal-foot-note">
              {t("Questions about this page? Reach us at")}{" "}
              <a href="mailto:legal@contentos.ai" className="auth-link">legal@contentos.ai</a>.
            </p>
          </article>
        </div>

        <MarketingFooter />
      </main>
    </>
  );
}
