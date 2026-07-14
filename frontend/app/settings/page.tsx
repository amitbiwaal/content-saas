"use client";

import { useEffect, useState } from "react";
import Shell from "../../components/Shell";
import { api } from "../../lib/api";
import type { Health, Integrations } from "../../lib/types";
import { useLang } from "../../lib/i18n";

function StatusPill({ ok, on, off }: { ok: boolean; on: string; off: string }) {
  return <span className={`pill ${ok ? "ok" : "warn"}`}>{ok ? on : off}</span>;
}

export default function SettingsPage() {
  const { t } = useLang();
  const [health, setHealth] = useState<Health | null>(null);
  const [integ, setInteg] = useState<Integrations | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(String(e)));
    api.getIntegrations().then(setInteg).catch(() => {});
  }, []);

  return (
    <Shell title={t("Settings")}>
      <section className="panel">
        <h2>{t("Provider adapter (PRD §12)")}</h2>
        <p className="muted">
          {t("Each council seat maps to a provider/model via the registry — no model is hardcoded. A seat with no key falls back to the deterministic mock. Set keys in")} <code>backend/.env</code>.
        </p>
        {error && <p className="error">{error}</p>}
        {health && (
          <div className="seats">
            {Object.entries(health.providers).map(([name, info]) => (
              <div className="card seat" key={name}>
                <div className="seat-head">
                  <span className="seat-name">{name}</span>
                  <span className={`tag ${info.policy_tier === "permissive" ? "tag-green" : "tag-blue"}`}>
                    {info.policy_tier}
                  </span>
                </div>
                <div className="seat-model">{info.model}</div>
                <div className={`seat-key ${info.key_configured ? "live" : "mock"}`}>
                  {info.key_configured ? t("live key configured") : t("mock fallback (no key)")}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>{t("Integrations (PRD §15)")}</h2>
        <p className="muted">
          {t("Live when credentials are set in")} <code>backend/.env</code>{t("; otherwise dry-run / mock. Secrets are never shown.")}
        </p>
        {integ && (
          <div className="seats">
            <div className="card seat">
              <div className="seat-head"><span className="seat-name">WordPress</span>
                <StatusPill ok={integ.wordpress.configured} on={t("live")} off={t("dry-run")} /></div>
              <div className="seat-model">{integ.wordpress.site_url || t("no site configured")}</div>
              <div className="muted small">{t("REST · Gutenberg blocks · RankMath/Yoast · scheduling")}</div>
            </div>
            <div className="card seat">
              <div className="seat-head"><span className="seat-name">Google Docs</span>
                <StatusPill ok={integ.google_docs.configured} on={t("live")} off={t("dry-run")} /></div>
              <div className="muted small">{t("Export formatted doc for review")}</div>
            </div>
            <div className="card seat">
              <div className="seat-head"><span className="seat-name">{t("Ahrefs (SERP/keyword)")}</span>
                <StatusPill ok={integ.ahrefs.configured} on={t("key set")} off={t("mock")} /></div>
              <div className="muted small">{integ.ahrefs.active ? t("active research provider") : t("set RESEARCH_PROVIDER=ahrefs to activate")}</div>
            </div>
            <div className="card seat">
              <div className="seat-head"><span className="seat-name">{t("Exports")}</span>
                <StatusPill ok={integ.docx.available} on={t("DOCX ready")} off={t("no DOCX")} /></div>
              <div className="chips" style={{ marginTop: 8 }}>
                {integ.exports.map((e) => <span className="chip-e" key={e}>{e}</span>)}
              </div>
            </div>
          </div>
        )}
      </section>
    </Shell>
  );
}
