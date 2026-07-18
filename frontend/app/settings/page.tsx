"use client";

import { useEffect, useState } from "react";
import Shell from "../../components/Shell";
import { api, type WebhookConfig, type WordpressConfig } from "../../lib/api";
import { creditsChanged, type CreditsResp } from "../../lib/auth";
import type { Health } from "../../lib/types";
import { useLang } from "../../lib/i18n";

function StatusPill({ ok, on, off }: { ok: boolean; on: string; off: string }) {
  return <span className={`pill ${ok ? "ok" : "warn"}`}>{ok ? on : off}</span>;
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^\d+:\s*/, ""); // strip the "400: " status prefix
}

const REASON_LABEL: Record<string, string> = {
  signup: "Welcome bonus", run: "Article run", topup: "Top-up", refund: "Refund",
};

export default function SettingsPage() {
  const { t } = useLang();
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- Credits ---
  const [credits, setCredits] = useState<CreditsResp | null>(null);

  // --- WordPress connect ---
  const [wp, setWp] = useState<WordpressConfig | null>(null);
  const [form, setForm] = useState({ site_url: "", username: "", app_password: "", default_status: "draft" });
  const [wpBusy, setWpBusy] = useState<"" | "save" | "test">("");
  const [wpMsg, setWpMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // --- Custom site (webhook) connect ---
  const [wh, setWh] = useState<WebhookConfig | null>(null);
  const [whForm, setWhForm] = useState({ endpoint_url: "", auth_token: "", default_status: "draft" });
  const [whBusy, setWhBusy] = useState<"" | "save" | "test">("");
  const [whMsg, setWhMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(String(e)));
    api.auth.credits().then(setCredits).catch(() => {});
    api.getWordpress().then((w) => {
      setWp(w);
      if (w.connected) setForm({ site_url: w.site_url, username: w.username, app_password: "", default_status: w.default_status });
    }).catch(() => {});
    api.getWebhook().then((w) => {
      setWh(w);
      if (w.connected) setWhForm({ endpoint_url: w.endpoint_url, auth_token: "", default_status: w.default_status });
    }).catch(() => {});
  }, []);

  async function saveWp() {
    if (!form.site_url.trim() || !form.username.trim() || !form.app_password.trim()) {
      setWpMsg({ ok: false, text: t("Fill in the site URL, username and application password.") });
      return;
    }
    setWpBusy("save"); setWpMsg(null);
    try {
      const w = await api.saveWordpress(form);
      setWp(w);
      setWpMsg({ ok: true, text: t("Saved. Now test the connection.") });
    } catch (e) {
      setWpMsg({ ok: false, text: errText(e) });
    } finally { setWpBusy(""); }
  }

  async function testWp() {
    setWpBusy("test"); setWpMsg(null);
    try {
      const w = await api.testWordpress();
      setWp(w);
      setWpMsg({ ok: true, text: t("Connection verified — you can publish to this site.") });
    } catch (e) {
      setWpMsg({ ok: false, text: errText(e) });
    } finally { setWpBusy(""); }
  }

  async function disconnectWp() {
    await api.deleteWordpress().catch(() => {});
    setWp({ connected: false, site_url: "", username: "", default_status: "draft", verified: false });
    setForm({ site_url: "", username: "", app_password: "", default_status: "draft" });
    setWpMsg(null);
  }

  async function saveWh() {
    if (!whForm.endpoint_url.trim()) {
      setWhMsg({ ok: false, text: t("Enter your publish endpoint URL.") });
      return;
    }
    setWhBusy("save"); setWhMsg(null);
    try {
      const w = await api.saveWebhook({
        endpoint_url: whForm.endpoint_url,
        auth_token: whForm.auth_token || undefined,
        default_status: whForm.default_status,
      });
      setWh(w);
      setWhMsg({ ok: true, text: t("Saved. Now test the connection.") });
    } catch (e) {
      setWhMsg({ ok: false, text: errText(e) });
    } finally { setWhBusy(""); }
  }

  async function testWh() {
    setWhBusy("test"); setWhMsg(null);
    try {
      const w = await api.testWebhook();
      setWh(w);
      setWhMsg({ ok: true, text: t("Endpoint reachable — you can publish to it.") });
    } catch (e) {
      setWhMsg({ ok: false, text: errText(e) });
    } finally { setWhBusy(""); }
  }

  async function disconnectWh() {
    await api.deleteWebhook().catch(() => {});
    setWh({ connected: false, endpoint_url: "", has_token: false, default_status: "draft", verified: false });
    setWhForm({ endpoint_url: "", auth_token: "", default_status: "draft" });
    setWhMsg(null);
  }

  return (
    <Shell title={t("Settings")}>
      {/* Credits / billing */}
      <section className="panel">
        <h2>{t("Credits & usage")}</h2>
        <p className="muted">{t("Every article run meters credits by length and models used. New accounts start with 500 free credits.")}</p>
        <div className="credits-balance">
          <span className="credits-big">{(credits?.credits ?? 0).toLocaleString("en-US")}</span>
          <span className="credits-unit">{t("credits left")}</span>
        </div>
        {credits && credits.ledger.length > 0 && (
          <div className="ledger">
            <div className="ledger-head">
              <span>{t("Activity")}</span><span>{t("Change")}</span><span>{t("Balance")}</span>
            </div>
            {credits.ledger.slice(0, 12).map((e, i) => (
              <div className="ledger-row" key={i}>
                <span className="ledger-reason">{t(REASON_LABEL[e.reason] || e.reason)}{e.detail ? ` · ${e.detail}` : ""}</span>
                <span className={`ledger-delta ${e.delta < 0 ? "neg" : "pos"}`}>{e.delta > 0 ? "+" : ""}{e.delta}</span>
                <span className="ledger-bal">{e.balance_after}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* WordPress connect */}
      <section className="panel">
        <h2>{t("Connect WordPress")}</h2>
        <p className="muted">
          {t("Publish finished articles straight to your site. Use a WordPress")} <strong>{t("Application Password")}</strong> {t("(Users → Profile → Application Passwords in wp-admin), not your login password.")}
        </p>
        {wp?.connected && (
          <div className="wp-status">
            <StatusPill ok={wp.verified} on={t("Verified")} off={t("Saved — not yet tested")} />
            <span className="muted small">{wp.site_url}</span>
          </div>
        )}
        <div className="wp-form">
          <label className="auth-field">
            <span className="auth-field-label">{t("Site URL")}</span>
            <input value={form.site_url} onChange={(e) => setForm({ ...form, site_url: e.target.value })} placeholder="https://yourblog.com" />
          </label>
          <label className="auth-field">
            <span className="auth-field-label">{t("Username")}</span>
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="admin" autoComplete="off" />
          </label>
          <label className="auth-field">
            <span className="auth-field-label">{t("Application password")}</span>
            <input type="password" value={form.app_password} onChange={(e) => setForm({ ...form, app_password: e.target.value })} placeholder={wp?.connected ? "•••• (re-enter to change)" : "xxxx xxxx xxxx xxxx"} autoComplete="off" />
          </label>
          <label className="auth-field">
            <span className="auth-field-label">{t("Publish as")}</span>
            <select value={form.default_status} onChange={(e) => setForm({ ...form, default_status: e.target.value })}>
              <option value="draft">{t("Draft (review in wp-admin)")}</option>
              <option value="publish">{t("Publish immediately")}</option>
            </select>
          </label>
        </div>
        {wpMsg && <p className={wpMsg.ok ? "ok-text" : "error"}>{wpMsg.text}</p>}
        <div className="wp-actions">
          <button className="btn btn-primary" onClick={saveWp} disabled={wpBusy !== ""}>{wpBusy === "save" ? `${t("Saving")}…` : t("Save")}</button>
          <button className="btn" onClick={testWp} disabled={wpBusy !== "" || !wp?.connected}>{wpBusy === "test" ? `${t("Testing")}…` : t("Test connection")}</button>
          {wp?.connected && <button className="btn wp-disconnect" onClick={disconnectWp} disabled={wpBusy !== ""}>{t("Disconnect")}</button>}
        </div>
      </section>

      {/* Custom site (generic webhook) connect — for non-WordPress stacks */}
      <section className="panel">
        <h2>{t("Publish to a custom site")}</h2>
        <p className="muted">
          {t("Not on WordPress? Give a URL on your site (or backend) that accepts a POST — we send each finished article as JSON (title, HTML, Markdown, meta). Works with Ghost, Webflow, a headless CMS, or your own API.")}
        </p>
        {wh?.connected && (
          <div className="wp-status">
            <StatusPill ok={wh.verified} on={t("Reachable")} off={t("Saved — not yet tested")} />
            <span className="muted small">{wh.endpoint_url}</span>
          </div>
        )}
        <div className="wp-form">
          <label className="auth-field">
            <span className="auth-field-label">{t("Endpoint URL")}</span>
            <input value={whForm.endpoint_url} onChange={(e) => setWhForm({ ...whForm, endpoint_url: e.target.value })} placeholder="https://yoursite.com/api/publish" />
          </label>
          <label className="auth-field">
            <span className="auth-field-label">{t("Auth token (optional)")}</span>
            <input type="password" value={whForm.auth_token} onChange={(e) => setWhForm({ ...whForm, auth_token: e.target.value })} placeholder={wh?.has_token ? "•••• (re-enter to change)" : t("sent as Authorization: Bearer …")} autoComplete="off" />
          </label>
          <label className="auth-field">
            <span className="auth-field-label">{t("Publish as")}</span>
            <select value={whForm.default_status} onChange={(e) => setWhForm({ ...whForm, default_status: e.target.value })}>
              <option value="draft">{t("Draft")}</option>
              <option value="publish">{t("Publish")}</option>
            </select>
          </label>
        </div>
        {whMsg && <p className={whMsg.ok ? "ok-text" : "error"}>{whMsg.text}</p>}
        <div className="wp-actions">
          <button className="btn btn-primary" onClick={saveWh} disabled={whBusy !== ""}>{whBusy === "save" ? `${t("Saving")}…` : t("Save")}</button>
          <button className="btn" onClick={testWh} disabled={whBusy !== "" || !wh?.connected}>{whBusy === "test" ? `${t("Testing")}…` : t("Test connection")}</button>
          {wh?.connected && <button className="btn wp-disconnect" onClick={disconnectWh} disabled={whBusy !== ""}>{t("Disconnect")}</button>}
        </div>
      </section>

      {/* Provider adapters (read-only, server-configured) */}
      <section className="panel">
        <h2>{t("AI providers")}</h2>
        <p className="muted">
          {t("Each council seat maps to a provider/model. A seat with no server key falls back to the deterministic mock. Set keys in")} <code>backend/.env</code>.
        </p>
        {error && <p className="error">{error}</p>}
        {health && (
          <div className="seats">
            {Object.entries(health.providers).map(([name, info]) => (
              <div className="card seat" key={name}>
                <div className="seat-head">
                  <span className="seat-name">{name}</span>
                  <span className={`tag ${info.policy_tier === "permissive" ? "tag-green" : "tag-blue"}`}>{info.policy_tier}</span>
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
    </Shell>
  );
}
