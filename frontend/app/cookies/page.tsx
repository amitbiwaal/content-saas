"use client";

import LegalShell, { type LegalSection } from "../../components/LegalShell";

const SECTIONS: LegalSection[] = [
  {
    id: "what",
    heading: "What are cookies?",
    paras: ["Cookies are small text files stored on your device when you visit a website. They help sites remember your preferences, keep you signed in, and understand how the product is used."],
  },
  {
    id: "how",
    heading: "How we use cookies",
    paras: ["ContentOS uses cookies and similar technologies (such as local storage) to operate the app, remember your settings, and improve the experience."],
  },
  {
    id: "types",
    heading: "Types of cookies we use",
    list: [
      "Essential — required to sign you in, keep your session secure, and run core features. The app does not work without these.",
      "Preferences — remember choices like your theme (light/dark) and language.",
      "Analytics — help us understand usage so we can improve the product. These are aggregated and optional.",
    ],
  },
  {
    id: "third-party",
    heading: "Third-party cookies",
    paras: ["Some cookies may be set by third-party services we use, such as analytics providers or embedded tools. Those providers process data under their own policies."],
  },
  {
    id: "managing",
    heading: "Managing cookies",
    paras: ["You can control or delete cookies through your browser settings, and block them entirely if you prefer. Note that disabling essential cookies may break sign-in and core features."],
  },
  {
    id: "changes",
    heading: "Changes to this policy",
    paras: ["We may update this Cookie Policy as our practices change. The date at the top of this page reflects the latest revision."],
  },
];

export default function CookiesPage() {
  return (
    <LegalShell
      title="Cookie Policy"
      updated="July 15, 2026"
      intro="This Cookie Policy explains how ContentOS AI uses cookies and similar technologies, and the choices available to you."
      sections={SECTIONS}
    />
  );
}
