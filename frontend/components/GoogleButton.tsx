"use client";

// Google Sign-In (GIS) button. Renders the official Google button when
// NEXT_PUBLIC_GOOGLE_CLIENT_ID is configured; otherwise renders nothing (so the
// email/password path is always available). On success it exchanges the Google
// ID token for our JWT via /api/auth/google and stores it.

import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { setToken } from "../lib/auth";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

type GoogleId = {
  accounts?: {
    id?: {
      initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void;
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
    };
  };
};

export default function GoogleButton({
  onSuccess,
  onError,
}: {
  onSuccess: () => void;
  onError?: (msg: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!CLIENT_ID || typeof window === "undefined") return;
    const w = window as unknown as { google?: GoogleId };

    function init() {
      const gid = w.google?.accounts?.id;
      if (!gid || !ref.current) return;
      gid.initialize({
        client_id: CLIENT_ID as string,
        callback: async (resp: { credential: string }) => {
          try {
            const r = await api.auth.google(resp.credential);
            setToken(r.token);
            onSuccess();
          } catch (e) {
            onError?.(e instanceof Error ? e.message : "Google sign-in failed.");
          }
        },
      });
      gid.renderButton(ref.current, { theme: "filled_black", size: "large", width: 320, text: "continue_with", shape: "pill" });
    }

    if (w.google?.accounts?.id) {
      init();
      return;
    }
    const SCRIPT_ID = "google-gsi";
    let s = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!s) {
      s = document.createElement("script");
      s.id = SCRIPT_ID;
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }
    s.addEventListener("load", init);
    return () => s?.removeEventListener("load", init);
  }, [onSuccess, onError]);

  if (!CLIENT_ID) return null;
  return <div ref={ref} className="google-btn" aria-label="Sign in with Google" />;
}
