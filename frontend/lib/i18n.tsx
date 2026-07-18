"use client";

import type { ReactNode } from "react";

// The app is English-only. The multi-language selector and locale dictionaries
// were removed; `t` is kept as a passthrough so the existing `t("…")` call sites
// across the UI keep working unchanged — it simply returns its argument.

export function LanguageProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export const useLang = () => ({ t: (s: string) => s });
