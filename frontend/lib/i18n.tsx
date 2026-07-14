"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DICT } from "./locales";

// Lightweight i18n: English is the source (keys ARE the English text), other
// languages provide static translations (see ./locales.ts) and fall back to
// English for anything missing — no runtime translation, no flicker.

export const LANGS = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "hi", label: "हिन्दी", flag: "🇮🇳" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "ar", label: "العربية", flag: "🇸🇦" },
] as const;

export type LangCode = (typeof LANGS)[number]["code"];
const RTL = new Set<LangCode>(["ar"]);

type Ctx = { lang: LangCode; setLang: (c: LangCode) => void; t: (s: string) => string };
const LanguageCtx = createContext<Ctx>({ lang: "en", setLang: () => {}, t: (s) => s });

function apply(code: LangCode) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = code;
  document.documentElement.dir = RTL.has(code) ? "rtl" : "ltr";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LangCode>("en");

  useEffect(() => {
    const saved = (localStorage.getItem("lang") as LangCode) || "en";
    setLangState(saved);
    apply(saved);
  }, []);

  const setLang = (code: LangCode) => {
    setLangState(code);
    try { localStorage.setItem("lang", code); } catch { /* ignore */ }
    apply(code);
  };

  const t = (s: string) => (lang === "en" ? s : DICT[lang]?.[s] ?? s);

  return <LanguageCtx.Provider value={{ lang, setLang, t }}>{children}</LanguageCtx.Provider>;
}

export const useLang = () => useContext(LanguageCtx);
