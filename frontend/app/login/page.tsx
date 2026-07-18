"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import AuthShell from "../../components/AuthShell";
import GoogleButton from "../../components/GoogleButton";
import { api } from "../../lib/api";
import { safeNext, setToken } from "../../lib/auth";
import { useLang } from "../../lib/i18n";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GOOGLE_ENABLED = !!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

export default function LoginPage() {
  const { t } = useLang();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!EMAIL_RE.test(email)) return setErr(t("Enter a valid email address."));
    if (pw.length < 8) return setErr(t("Password must be at least 8 characters."));
    setBusy(true);
    try {
      const r = await api.auth.login({ email: email.trim(), password: pw });
      setToken(r.token);
      router.push(safeNext());
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "";
      setErr(msg.startsWith("401") ? t("Wrong email or password.") : t("Sign-in failed. Try again."));
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={t("Welcome back")}
      subtitle={t("Sign in to your ContentOS workspace.")}
      footer={<>{t("New to ContentOS?")} <Link href="/signup" className="auth-link">{t("Create an account")}</Link></>}
    >
      {GOOGLE_ENABLED && (
        <>
          <div className="auth-sso">
            <GoogleButton onSuccess={() => router.push(safeNext())} onError={(m) => setErr(m)} />
          </div>
          <div className="auth-divider"><span>{t("or")}</span></div>
        </>
      )}

      <form className="auth-form" onSubmit={submit} noValidate>
        {err && <div className="auth-err" role="alert">{err}</div>}
        <label className="auth-field">
          <span className="auth-field-label">{t("Work email")}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" autoFocus />
        </label>
        <label className="auth-field">
          <span className="auth-field-label auth-field-row">
            {t("Password")}
            <Link href="/forgot-password" className="auth-link auth-link-sm">{t("Forgot password?")}</Link>
          </span>
          <div className="auth-pw">
            <input type={showPw ? "text" : "password"} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
            <button type="button" className="auth-pw-toggle" onClick={() => setShowPw((v) => !v)}>
              {showPw ? t("Hide") : t("Show")}
            </button>
          </div>
        </label>
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? `${t("Signing in")}…` : t("Sign in")}
        </button>
      </form>
    </AuthShell>
  );
}
