"use client";

import LegalShell, { type LegalSection } from "../../components/LegalShell";

const SECTIONS: LegalSection[] = [
  {
    id: "acceptance",
    heading: "Acceptance of terms",
    paras: ["By accessing or using ContentOS AI (the \"Service\"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service."],
  },
  {
    id: "service",
    heading: "The service",
    paras: ["ContentOS is a multi-model content platform that researches topics, generates drafts through a council of AI models, scores them, and helps you publish. Features may change, and we may add or remove functionality over time."],
  },
  {
    id: "accounts",
    heading: "Your account",
    paras: ["You are responsible for maintaining the confidentiality of your account credentials and for all activity under your account. Provide accurate information and keep it up to date. Notify us promptly of any unauthorized use."],
  },
  {
    id: "acceptable-use",
    heading: "Acceptable use",
    paras: ["You agree not to use the Service to:"],
    list: [
      "Produce unlawful, infringing, deceptive, or harmful content.",
      "Impersonate others or misrepresent generated content as independently verified fact.",
      "Reverse engineer, scrape, or disrupt the Service or its providers.",
      "Violate the terms of any connected third-party service or AI provider.",
    ],
  },
  {
    id: "content",
    heading: "Content & ownership",
    paras: [
      "You retain ownership of the briefs and materials you submit and, subject to these terms, of the output you generate. You grant us a limited license to process your content to operate the Service.",
      "The ContentOS platform, branding, and software are our intellectual property and may not be copied or reused without permission.",
    ],
  },
  {
    id: "ai-output",
    heading: "AI-generated output",
    paras: ["Content produced by AI models can be inaccurate, incomplete, or biased despite our review and scoring. You are responsible for reviewing, fact-checking, and approving any content before you publish or rely on it. ContentOS is a tool to assist your judgment, not a substitute for it."],
  },
  {
    id: "third-party",
    heading: "Third-party services",
    paras: ["The Service integrates third-party AI providers and publishing tools. Your use of those services is subject to their terms, and we are not responsible for their availability or output."],
  },
  {
    id: "billing",
    heading: "Fees & billing",
    paras: ["Paid plans, where offered, are billed in advance and are non-refundable except where required by law. We may change pricing with notice for future billing periods."],
  },
  {
    id: "termination",
    heading: "Termination",
    paras: ["You may stop using the Service at any time. We may suspend or terminate access if you violate these terms or to protect the Service and its users."],
  },
  {
    id: "disclaimer",
    heading: "Disclaimers",
    paras: ["The Service is provided \"as is\" and \"as available\" without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement."],
  },
  {
    id: "liability",
    heading: "Limitation of liability",
    paras: ["To the maximum extent permitted by law, ContentOS AI is not liable for indirect, incidental, or consequential damages, or for any loss arising from your use of the Service or reliance on generated content."],
  },
  {
    id: "changes",
    heading: "Changes to these terms",
    paras: ["We may update these terms from time to time. Continued use of the Service after changes take effect constitutes acceptance of the revised terms."],
  },
  {
    id: "law",
    heading: "Governing law",
    paras: ["These terms are governed by the laws of the jurisdiction in which ContentOS AI operates, without regard to conflict-of-law principles."],
  },
];

export default function TermsPage() {
  return (
    <LegalShell
      title="Terms of Service"
      updated="July 15, 2026"
      intro="These Terms of Service govern your access to and use of ContentOS AI. Please read them carefully."
      sections={SECTIONS}
    />
  );
}
