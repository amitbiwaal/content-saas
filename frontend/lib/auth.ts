// Client-side auth: stores the JWT (localStorage), exposes the current user, and
// the login/signup/google/logout actions. The token is sent as an Authorization
// header on every API call (see lib/api.ts) and, for the SSE run stream which
// cannot set headers, as a ?token= query param.

const TOKEN_KEY = "contentos_token";

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  credits: number;
  plan: string; // free | pro | business
  is_admin: boolean; // effective admin — gates the /admin panel
  has_wordpress: boolean;
  auth_configured: boolean; // Google Sign-In available
};

export type LedgerEntry = {
  delta: number;
  balance_after: number;
  reason: string;
  detail: string | null;
  project_id: string | null;
  created_at: string;
};

export type CreditsResp = { credits: number; ledger: LedgerEntry[] };

export type AuthResp = { token: string; user: AuthUser };

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window !== "undefined") localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
}

export function isAuthed(): boolean {
  return !!getToken();
}

export function logout(): void {
  clearToken();
  if (typeof window !== "undefined") window.location.href = "/login";
}

// After a protected page bounces to /login, we remember where the user was
// headed in ?next= and send them back there once they sign in — so trying to
// open /admin doesn't dump you on /chat. Only internal paths are honoured
// (protocol-relative //evil.com and the auth pages themselves are rejected).
export function safeNext(fallback = "/chat"): string {
  if (typeof window === "undefined") return fallback;
  const n = new URLSearchParams(window.location.search).get("next");
  if (n && n.startsWith("/") && !n.startsWith("//") && !/^\/(login|signup|forgot-password)\b/.test(n)) {
    return n;
  }
  return fallback;
}

/** Send the browser to /login, preserving the current path as ?next=. */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  const skip = pathname === "/" || /^\/(login|signup|forgot-password)\b/.test(pathname);
  window.location.href = skip ? "/login" : `/login?next=${encodeURIComponent(pathname + search)}`;
}

// Broadcast so the Shell/credits chip can refresh after a run charges credits.
export function creditsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("credits:changed"));
}
