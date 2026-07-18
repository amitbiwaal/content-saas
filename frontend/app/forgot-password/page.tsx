"use client";

import Link from "next/link";
import { useState } from "react";
import AuthShell from "../../components/AuthShell";
import { useLang } from "../../lib/i18n";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function ForgotPasswordPage() {
  const { t } = useLang();
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!EMAIL_RE.test(email)) return setErr(t("Enter a valid email address."));
    setBusy(true);
    window.setTimeout(() => { setBusy(false); setSent(true); }, 700);
  }

  if (sent) {
    return (
      <AuthShell
        title={t("Check your email")}
        subtitle={t("If an account exists for that address, we've sent a reset link.")}
        footer={<Link href="/login" className="auth-link">← {t("Back to sign in")}</Link>}
      >
        <div className="auth-sent">
          <div className="auth-sent-ic" aria-hidden="true">✉</div>
          <p className="auth-sent-to">{email}</p>
          <p className="auth-sent-hint">{t("The link expires in 30 minutes. Didn't get it? Check spam, or")} <button type="button" className="auth-link auth-linkbtn" onClick={() => setSent(false)}>{t("try another email")}</button>.</p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t("Reset your password")}
      subtitle={t("Enter your account email and we'll send you a reset link.")}
      footer={<Link href="/login" className="auth-link">← {t("Back to sign in")}</Link>}
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        {err && <div className="auth-err" role="alert">{err}</div>}
        <label className="auth-field">
          <span className="auth-field-label">{t("Work email")}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" autoFocus />
        </label>
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? `${t("Sending")}…` : t("Send reset link")}
        </button>
      </form>
    </AuthShell>
  );
}
