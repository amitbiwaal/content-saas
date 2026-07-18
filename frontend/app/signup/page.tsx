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

// Rough password-strength meter (0-3) for the signup affordance only.
function strength(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) s++;
  return pw ? s : 0;
}

export default function SignupPage() {
  const { t } = useLang();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const s = strength(pw);
  const strengthLabel = ["", t("Weak"), t("Fair"), t("Strong")][s];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (name.trim().length < 2) return setErr(t("Please enter your name."));
    if (!EMAIL_RE.test(email)) return setErr(t("Enter a valid email address."));
    if (pw.length < 8) return setErr(t("Password must be at least 8 characters."));
    if (!agree) return setErr(t("Please accept the Terms to continue."));
    setBusy(true);
    try {
      const r = await api.auth.signup({ email: email.trim(), password: pw, name: name.trim() });
      setToken(r.token);
      router.push(safeNext());
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "";
      setErr(msg.startsWith("409") ? t("An account with this email already exists.") : t("Could not create your account. Try again."));
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={t("Create your workspace")}
      subtitle={t("Start producing trusted content in minutes.")}
      footer={<>{t("Already have an account?")} <Link href="/login" className="auth-link">{t("Sign in")}</Link></>}
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
          <span className="auth-field-label">{t("Full name")}</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Alex Morgan")} autoComplete="name" autoFocus />
        </label>
        <label className="auth-field">
          <span className="auth-field-label">{t("Work email")}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" />
        </label>
        <label className="auth-field">
          <span className="auth-field-label">{t("Password")}</span>
          <div className="auth-pw">
            <input type={showPw ? "text" : "password"} value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t("At least 8 characters")} autoComplete="new-password" />
            <button type="button" className="auth-pw-toggle" onClick={() => setShowPw((v) => !v)}>
              {showPw ? t("Hide") : t("Show")}
            </button>
          </div>
          {pw && (
            <div className={`auth-strength s${s}`}>
              <span /><span /><span />
              <em>{strengthLabel}</em>
            </div>
          )}
        </label>
        <label className="auth-check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>{t("I agree to the")} <Link href="/terms" className="auth-link">{t("Terms")}</Link> {t("and")} <Link href="/privacy" className="auth-link">{t("Privacy Policy")}</Link></span>
        </label>
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? `${t("Creating account")}…` : t("Create account")}
        </button>
      </form>
    </AuthShell>
  );
}
