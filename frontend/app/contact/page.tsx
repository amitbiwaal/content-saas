"use client";

import { useState } from "react";
import LandingHeader from "../../components/LandingHeader";
import MarketingFooter from "../../components/MarketingFooter";
import { useLang } from "../../lib/i18n";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const METHODS = [
  { icon: "✉", label: "General", value: "hello@contentos.ai", href: "mailto:hello@contentos.ai" },
  { icon: "🛟", label: "Support", value: "support@contentos.ai", href: "mailto:support@contentos.ai" },
  { icon: "🔒", label: "Privacy & legal", value: "legal@contentos.ai", href: "mailto:legal@contentos.ai" },
];

const TOPICS = ["General", "Sales", "Support", "Partnership", "Press"];

export default function ContactPage() {
  const { t } = useLang();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState("General");
  const [message, setMessage] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (name.trim().length < 2) return setErr(t("Please enter your name."));
    if (!EMAIL_RE.test(email)) return setErr(t("Enter a valid email address."));
    if (message.trim().length < 10) return setErr(t("Please add a few more details (10+ characters)."));
    setBusy(true);
    window.setTimeout(() => { setBusy(false); setSent(true); }, 700);
  }

  return (
    <>
      <LandingHeader />
      <main className="lp contact">
        <div className="about-inner contact-grid">
          {/* Left: intro + methods */}
          <div className="contact-intro">
            <span className="lp-eyebrow"><span className="lp-eyebrow-dot" />{t("CONTACT")}</span>
            <h1 className="contact-h1">{t("Talk to us")}</h1>
            <p className="contact-lede">{t("Questions, feedback, or want a demo? We usually reply within one business day.")}</p>
            <div className="contact-methods">
              {METHODS.map((m) => (
                <a className="contact-method" href={m.href} key={m.label}>
                  <span className="contact-method-ic" aria-hidden="true">{m.icon}</span>
                  <span className="contact-method-text">
                    <span className="contact-method-label">{t(m.label)}</span>
                    <span className="contact-method-value">{m.value}</span>
                  </span>
                </a>
              ))}
            </div>
          </div>

          {/* Right: form card */}
          <div className="contact-card">
            {sent ? (
              <div className="contact-sent">
                <div className="contact-sent-ic" aria-hidden="true">✓</div>
                <h2 className="contact-sent-title">{t("Message sent")}</h2>
                <p className="contact-sent-sub">{t("Thanks for reaching out — we'll get back to you at")} <strong>{email}</strong> {t("soon.")}</p>
                <button type="button" className="btn btn-ghost" onClick={() => { setSent(false); setName(""); setEmail(""); setMessage(""); }}>
                  {t("Send another")}
                </button>
              </div>
            ) : (
              <form className="auth-form" onSubmit={submit} noValidate>
                {err && <div className="auth-err" role="alert">{err}</div>}
                <div className="contact-row">
                  <label className="auth-field">
                    <span className="auth-field-label">{t("Name")}</span>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Your name")} autoComplete="name" />
                  </label>
                  <label className="auth-field">
                    <span className="auth-field-label">{t("Email")}</span>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" />
                  </label>
                </div>
                <label className="auth-field">
                  <span className="auth-field-label">{t("Topic")}</span>
                  <div className="contact-topics">
                    {TOPICS.map((tp) => (
                      <button type="button" key={tp} className={`contact-topic ${topic === tp ? "on" : ""}`} onClick={() => setTopic(tp)}>{t(tp)}</button>
                    ))}
                  </div>
                </label>
                <label className="auth-field">
                  <span className="auth-field-label">{t("Message")}</span>
                  <textarea className="contact-textarea" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t("How can we help?")} rows={5} />
                </label>
                <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
                  {busy ? `${t("Sending")}…` : t("Send message")}
                </button>
                <p className="contact-legal">{t("By submitting, you agree to our")} <a href="/privacy" className="auth-link">{t("Privacy Policy")}</a>.</p>
              </form>
            )}
          </div>
        </div>
        <MarketingFooter />
      </main>
    </>
  );
}
