// Single source of truth for plans and credit maths — imported by BOTH the
// landing pricing teaser (/#pricing) and the dedicated pricing page (/pricing),
// so the two can never drift apart.
//
// The credit numbers mirror backend/app/credits.py exactly (1 credit ≈ 1 US cent
// of budgeted spend; a run is charged up front from the target length). Keep
// BASE_RUN_CREDITS / WORDS_PER_CREDIT in step with that module.

// Self-serve checkout isn't wired yet (no payment provider). While false, paid
// plans show "Coming soon" instead of an Upgrade CTA everywhere. Flip to true
// once payments are live — admins can still set a plan manually meanwhile.
export const PAYMENTS_ENABLED = false;

export const BASE_RUN_CREDITS = 10;
export const WORDS_PER_CREDIT = 150;
export const DEFAULT_WORDS = 1500;

/** Credits one run costs — mirrors estimate_run_credits() in the backend. */
export function runCredits(words: number = DEFAULT_WORDS): number {
  return BASE_RUN_CREDITS + Math.round(words / WORDS_PER_CREDIT);
}

/** Months actually billed on an annual plan — i.e. two months free. */
export const ANNUAL_MONTHS_BILLED = 10;

export type PlanId = "free" | "pro" | "business";

export type Plan = {
  id: PlanId;
  name: string;
  note: string;
  /** USD per month when billed monthly. */
  monthly: number;
  /** Credits granted per month. */
  credits: number;
  popular?: boolean;
  cta: string;
  features: string[];
};

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    note: "For a first project",
    monthly: 0,
    credits: 500,
    cta: "Start free",
    features: [
      "1 active project",
      "Mock providers, zero API spend",
      "Markdown & HTML export",
      "Community support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    note: "For operators shipping weekly",
    monthly: 29,
    credits: 5000,
    popular: true,
    cta: "Upgrade to Pro",
    features: [
      "Unlimited projects",
      "Bring your own AI keys",
      "One-click WordPress publishing",
      "Priority council routing",
      "All 8 scores plus fact-check",
    ],
  },
  {
    id: "business",
    name: "Business",
    note: "For multi-site teams",
    monthly: 99,
    credits: 25000,
    cta: "Upgrade to Business",
    features: [
      "Everything in Pro",
      "Team seats & roles",
      "Custom house rules",
      "Restricted-niche routing",
      "Full API access",
    ],
  },
];

export const planById = (id: PlanId): Plan =>
  PLANS.find((p) => p.id === id) as Plan;

/** Total charged once a year (two months free). */
export const annualTotal = (p: Plan) => p.monthly * ANNUAL_MONTHS_BILLED;
/** Per-month equivalent when billed annually — the figure the card shows. */
export const annualPerMonth = (p: Plan) => Math.round(annualTotal(p) / 12);
/** Roughly how many articles a plan's monthly credits buy at a given length. */
export const articlesPerMonth = (p: Plan, words: number = DEFAULT_WORDS) =>
  Math.floor(p.credits / runCredits(words));

const num = (n: number) => n.toLocaleString("en-US");

/** Worked examples for the "how credits work" explainer. */
export const CREDIT_EXAMPLES = [
  { words: 800, label: "Short post" },
  { words: DEFAULT_WORDS, label: "Typical article" },
  { words: 3000, label: "Long-form guide" },
].map((e) => ({ ...e, credits: runCredits(e.words) }));

export type Cell = boolean | string;

export const COMPARISON: {
  group: string;
  rows: { label: string; free: Cell; pro: Cell; business: Cell }[];
}[] = [
  {
    group: "Projects & credits",
    rows: [
      { label: "Active projects", free: "1", pro: "Unlimited", business: "Unlimited" },
      {
        label: "Monthly credits",
        free: num(planById("free").credits),
        pro: num(planById("pro").credits),
        business: num(planById("business").credits),
      },
      {
        label: `Articles per month (~${num(DEFAULT_WORDS)} words)`,
        free: `~${num(articlesPerMonth(planById("free")))}`,
        pro: `~${num(articlesPerMonth(planById("pro")))}`,
        business: `~${num(articlesPerMonth(planById("business")))}`,
      },
    ],
  },
  {
    group: "The council",
    rows: [
      { label: "Four-model council debate", free: true, pro: true, business: true },
      { label: "Judge with human override", free: true, pro: true, business: true },
      { label: "Priority council routing", free: false, pro: true, business: true },
      { label: "Restricted-niche routing", free: false, pro: false, business: true },
      { label: "Custom house rules", free: false, pro: false, business: true },
    ],
  },
  {
    group: "Quality gate",
    rows: [
      { label: "8-score publish gate", free: true, pro: true, business: true },
      { label: "Fact-check with sources", free: true, pro: true, business: true },
    ],
  },
  {
    group: "Providers",
    rows: [
      { label: "Mock providers (zero API spend)", free: true, pro: true, business: true },
      { label: "Bring your own AI keys", free: false, pro: true, business: true },
      { label: "Per-article & monthly cost caps", free: false, pro: true, business: true },
    ],
  },
  {
    group: "Publish & export",
    rows: [
      { label: "Markdown & HTML export", free: true, pro: true, business: true },
      { label: "DOCX, Google Docs & JSON-LD", free: false, pro: true, business: true },
      { label: "One-click WordPress publishing", free: false, pro: true, business: true },
    ],
  },
  {
    group: "Team & API",
    rows: [
      { label: "Team seats & roles", free: false, pro: false, business: true },
      { label: "Full API access", free: false, pro: false, business: true },
      { label: "Support", free: "Community", pro: "Priority email", business: "Dedicated" },
    ],
  },
];

export const PRICING_FAQ = [
  {
    q: "What exactly is a credit?",
    a: `One credit is about one US cent of budgeted model spend. A run is charged ${BASE_RUN_CREDITS} credits up front plus one for every ${WORDS_PER_CREDIT} words of target length, so a typical ${num(DEFAULT_WORDS)}-word article costs about ${runCredits()} credits.`,
  },
  {
    q: "Do I need a card to start?",
    a: `No. Every account starts with ${num(planById("free").credits)} credits, and with no provider keys set the whole pipeline runs on the deterministic mock adapter at zero API spend — council debate, Judge, scoring and all.`,
  },
  {
    q: "What happens when I run out of credits?",
    a: "The run is blocked before any provider is called, so you never get a surprise bill — you just see a 'not enough credits' notice with what the run needed. Nothing is charged and no partial work is billed.",
  },
  {
    q: "Can I use my own AI keys?",
    a: "Yes, on Pro and above. Add your own OpenAI, Anthropic, Google or xAI keys and each seat calls your account directly. Any seat you leave blank falls back to the free mock adapter, and you can set per-article and monthly cost caps.",
  },
  {
    q: "Is annual billing cheaper?",
    a: `Yes — annual plans are billed for ${ANNUAL_MONTHS_BILLED} months instead of 12, so two months are free. Pro works out to $${annualPerMonth(planById("pro"))}/mo billed $${num(annualTotal(planById("pro")))} a year.`,
  },
  {
    q: "What counts as an active project?",
    a: "A project is one brief and everything the pipeline produces for it — research, the council debate, the outline, the draft, scores and exports. Free keeps one project active at a time; Pro and Business are unlimited.",
  },
];
