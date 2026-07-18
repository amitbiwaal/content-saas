"use client";

import LegalShell, { type LegalSection } from "../../components/LegalShell";

const SECTIONS: LegalSection[] = [
  {
    id: "collect",
    heading: "Information we collect",
    paras: ["We collect information you provide directly and information generated as you use ContentOS:"],
    list: [
      "Account data — your name, email address, and workspace settings.",
      "Content you submit — briefs, keywords, reference links, and any text you enter.",
      "Generated content — research, drafts, scores, and decisions produced by the service.",
      "Usage data — pages visited, features used, and diagnostic logs.",
    ],
  },
  {
    id: "use",
    heading: "How we use your information",
    paras: ["We use the information we collect to:"],
    list: [
      "Provide, operate, and improve the ContentOS service.",
      "Run your briefs through the AI council and generate content.",
      "Secure your account and prevent abuse.",
      "Communicate with you about updates, security, and support.",
    ],
  },
  {
    id: "ai",
    heading: "AI processing & third-party models",
    paras: [
      "ContentOS routes your briefs to third-party AI providers (such as OpenAI, Anthropic, Google, and xAI) to generate research and drafts. The content you submit is sent to these providers solely to produce your output.",
      "Each provider processes data under its own terms. We do not use your content to train our own models.",
    ],
  },
  {
    id: "sharing",
    heading: "Sharing & disclosure",
    paras: ["We do not sell your personal information. We share data only with:"],
    list: [
      "Service providers who help us operate the platform (hosting, AI model providers, analytics).",
      "Integrations you explicitly connect, such as WordPress, when you choose to publish.",
      "Authorities, where required by law or to protect our rights and users.",
    ],
  },
  {
    id: "retention",
    heading: "Data retention",
    paras: ["We keep your data for as long as your account is active or as needed to provide the service. You can delete projects at any time, and we remove associated data within a reasonable period after account closure."],
  },
  {
    id: "security",
    heading: "Security",
    paras: ["We use technical and organizational measures — including encryption in transit and access controls — to protect your data. No method of transmission or storage is completely secure, so we cannot guarantee absolute security."],
  },
  {
    id: "rights",
    heading: "Your rights",
    paras: ["Depending on where you live, you may have the right to access, correct, export, or delete your personal information, and to object to certain processing. To exercise these rights, contact us at privacy@contentos.ai."],
  },
  {
    id: "cookies",
    heading: "Cookies",
    paras: ["We use cookies and similar technologies to keep you signed in and understand how the product is used. See our Cookie Policy for details and choices."],
  },
  {
    id: "children",
    heading: "Children's privacy",
    paras: ["ContentOS is not directed to children under 16, and we do not knowingly collect their personal information."],
  },
  {
    id: "changes",
    heading: "Changes to this policy",
    paras: ["We may update this policy from time to time. If we make material changes, we will notify you and update the date at the top of this page."],
  },
];

export default function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      updated="July 15, 2026"
      intro="This Privacy Policy explains what information ContentOS AI collects, how we use it, and the choices you have. By using ContentOS, you agree to the practices described here."
      sections={SECTIONS}
    />
  );
}
