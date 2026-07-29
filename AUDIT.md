# ContentOS AI — Technical & Commercial Due Diligence

**Date:** 28 July 2026
**Commit audited:** `e02c035`
**Scope:** 16,645 backend LOC · 16,438 frontend LOC · 15 commits · 14 days of development
**Method:** Full read of both codebases, live test-suite run, every headline claim verified against source.

> **Verdict: 4.9 / 10**
>
> A genuinely clever engine wearing a demo's clothes. The pipeline design would pass review at a good company. The trust layer around it — auth isolation, credential storage, fact verification, billing — would not survive a single enterprise security questionnaire, and there is no mechanism to charge anyone.

---

## Table of contents

| #                                           | Section                            |
| ------------------------------------------- | ---------------------------------- |
| [00](#00-verdict)                           | Verdict & the four blockers        |
| [01](#01-product-vision)                    | Product Vision                     |
| [02](#02-dashboard-ux-audit)                | Dashboard UX Audit                 |
| [03](#03-feature-audit)                     | Feature Audit                      |
| [04](#04-workflow-audit)                    | Workflow Audit                     |
| [05](#05-ui-design-audit)                   | UI Design Audit                    |
| [06](#06-information-architecture)          | Information Architecture           |
| [07](#07-ai-workflow-audit)                 | AI Workflow Audit                  |
| [08](#08-content-workflow-audit)            | Content Workflow Audit             |
| [09](#09-seo-engine-audit)                  | SEO Engine Audit                   |
| [10](#10-competitive-analysis)              | Competitive Analysis               |
| [11](#11-database--backend-architecture)    | Database & Backend Architecture    |
| [12](#12-performance-audit)                 | Performance Audit                  |
| [13](#13-security-audit)                    | Security Audit                     |
| [14](#14-pricing-audit)                     | Pricing Audit                      |
| [15](#15-business-audit)                    | Business Audit                     |
| [16](#16-roadmap)                           | Roadmap                            |
| [17](#17-scorecard--engineering-process)    | Scorecard & Engineering Process    |
| [A](#a--top-25-critical-improvements)       | Top 25 Critical Improvements       |
| [B](#b--ten-differentiators-worth-building) | Ten Differentiators Worth Building |
| [C](#c--can-it-compete)                     | Can It Compete?                    |

---

## 00 · Verdict

I read all 33,083 lines, ran the test suite, and verified every headline claim below against source. What follows is not a list of nitpicks. There are four defects that are individually sufficient to block a launch, and one of them — the fact-check escape hatch — directly falsifies the product's central promise.

### The four blockers

#### 🔴 CRITICAL — Any signed-in user can read every project on the platform

`portfolio_analytics()` runs `select(Project)` with no owner filter. Not an ID-guessing attack — a plain `GET /api/analytics` returns every tenant's topic, target keyword, pipeline stage and spend. Four more endpoints leak the same way by project ID: draft export, Google-Doc export, generated images (no auth at all), and per-project analytics.

**Fix:** Scope the query to `Project.owner_id == user.id`, and move the five orphaned routers onto the `require_project_access` dependency the other eight routers already use correctly. This is a one-line-per-router change; the correct pattern is already in your codebase.

> `backend/app/analytics/service.py:94` · `export/router.py:171,334` · `media/router.py:92` · `memory_engine/router.py:120,164,182`

#### 🔴 CRITICAL — Customer WordPress passwords are stored in plaintext

The column is `Mapped[str] = mapped_column(Text)` with the comment `# TODO: encrypt at rest for multi-tenant prod` sitting directly above it. This _is_ multi-tenant prod. Any database snapshot, backup, or read access to `wordpress_config` hands over publish rights to every customer's live site. Webhook bearer tokens are stored the same way. Your Postgres is on Render's free tier, which has no backup story at all.

**Fix:** Encrypt with Fernet from a `CREDENTIAL_KEY` env var before the write in `wordpress.py:90`, decrypt at publish time only. ~20 lines plus a migration that re-encrypts existing rows. Do this before you onboard one more site.

> `backend/app/models.py:489` (app_password), `:512` (auth_token)

#### 🔴 CRITICAL — The fact-checker accepts fabricated sources by regex

This is the one that matters most, because it falsifies the pitch. When a claim fails source matching, the code tries one more thing:

```python
if not supported:
    inline = _inline_citation(claim_text)
    if inline:
        chosen_source = inline
        supported = True
        score = max(score, 0.6)
```

`_inline_citation` is a pure regex. It matches `according to <Capitalised>`. **Nothing verifies that the named source exists** — not in the SERP, not in the evidence bank, not anywhere. So "According to Wirecutter, 62% of buyers return their first standing desk" is invented, fails matching, hits the regex, and is stamped `supported=True, risk=low, label=accepted`.

It then clears the publish gate (which blocks only on `high_risk_unsupported > 0`), raises the Fact score, raises the E-E-A-T score, and satisfies the compliance citation rule — whose regex is _laxer_ still, accepting "according to industry data" with no capital letter at all.

Worse: the system trains the model into this exact behaviour. The writer prompt says _"Attribute inline ('according to Wirecutter', 'per Tom's Guide')"_, and the auto-remediation prompt repeats it. When the fact-checker flags a claim, the cheapest way for the model to satisfy the fixer is to prepend "per Good Housekeeping." **You have built a loop that converts unsupported claims into accepted ones by adding words.**

**Fix:** Require the extracted source name to fuzzy-match a domain or title in `research.sources` ∪ `research.facts[].source`. If it doesn't match, leave it unsupported and let the gate do its job. Roughly 8 lines. Then add a regression test that feeds in a claim citing a fabricated outlet and asserts it stays blocked.

> `backend/app/factcheck/service.py:573-580`, regex at `:142-159` · prompt at `article/service.py:79-81` · `compliance/house_rules.py:130`

#### 🔴 CRITICAL — There is no way for a customer to pay you

`PAYMENTS_ENABLED = false`. No Stripe, no Paddle, no LemonSqueezy anywhere in either codebase. The pricing page advertises $29 and $99 tiers the system is structurally incapable of billing. Plan changes happen only through an admin route.

Meanwhile credits are charged up front and **never refunded** — grep for `refund` returns a docstring and a comment, and zero code paths. Every crash, every provider outage, and _every deploy_ (the startup reaper marks in-flight runs `interrupted`) silently burns paying users' balances.

**Fix:** Two separate jobs. (a) Stripe Checkout + a webhook that calls the `credits.set_plan` path that already exists — roughly a day. (b) A `refund` reason in `CreditLedger` and a call in the three failure paths (`hub._worker` except-block, `reap_interrupted`, gate-blocked runs). The ledger schema already supports it.

> `frontend/lib/pricing.ts:12` · `backend/app/credits.py:65` · `pipeline/hub.py:174-188, :243-250`

---

### Scorecard

| Dimension       |   Score | Note                                               |
| --------------- | ------: | -------------------------------------------------- |
| Product Vision  | **6.0** | Real thesis; undermined by its own implementation  |
| UI              | **6.5** | Run view is superb; no type or spacing scale       |
| UX              | **5.0** | Four competing run surfaces; editor loses data     |
| Architecture    | **5.0** | Clean modules, but daemon threads as a job queue   |
| Scalability     | **3.0** | Single process by construction. Cannot scale out   |
| Performance     | **5.0** | Great streaming; zero caching anywhere             |
| SEO             | **6.0** | Real Ahrefs data; no clusters, no gap analysis     |
| AI              | **6.0** | Sophisticated, then defeated by one regex          |
| Security        | **3.0** | Five broken tenant boundaries; plaintext secrets   |
| Business        | **2.0** | No pricing strategy, no GTM, no way to charge      |
| Innovation      | **7.0** | Council + hard gate + evidence bank is a real idea |
| Code Quality    | **6.5** | Exceptional comments; heavy duplication            |
| Maintainability | **5.0** | Docs describe a system that no longer exists       |
| **Overall**     | **4.9** | **Strong engine, unshippable trust layer**         |

---

### 💡 The single most important thing in this report

Almost every failure below is a **consistency failure, not a competence failure**. Eight routers use the correct authorization dependency; five don't. Two JSON call sites use a robust parser that lives in your own repo; eight use bare `json.loads`. The evidence engine implements exactly the right primitive — drop any fact whose claimed source wasn't actually fetched — and then the fact-checker overrides it with a regex.

You do not have an architecture problem. You have a "the good pattern didn't propagate" problem, which is dramatically cheaper to fix.

---

## 01 · Product Vision

**Score: 6.0 / 10**

**The problem it solves.** AI content tools produce fluent, unsourced, structurally identical articles that don't rank. ContentOS attacks this with three ideas stacked: run four frontier models as adversarial specialists, mine facts only from pages that actually rank today, and refuse to publish anything that fails a numeric gate. The PRD adds a fourth: route restricted niches (explicitly, adult-adjacent) to permissive providers that mainstream tools refuse to serve.

**Is the value proposition clear?** Yes, and unusually well-articulated. "Four AI models debate. One judge decides." is a better hero line than Surfer, Frase or MarketMuse currently run. A buyer understands it in four seconds.

**Is it solving the right problem?** Partially, and this is the strategic risk. The stated bet is that _disagreement between models improves content_. But trace what the debate actually produces: 14 LLM calls yield a strategy summary string and a filtered decision list, which shape H2 selection in the outline. **The article writer never sees council output at all** — `stream_draft()` receives the outline, brief and research, and nothing else.

Meanwhile the mechanism that _does_ measurably improve the article is the cross-model critic in the polish stage, which names the two weakest sections and triggers targeted rewrites. You built the marketing feature and the working feature, and you're selling the wrong one.

The genuinely right problem — the one the market has not solved — is _verifiable_ AI content. Your evidence engine is closer to that than anything Surfer or Frase ships. It is also the part with no marketing behind it.

**Feature bloat.** Yes, and it is diagnosable. Shipped and either unwired or unused:

- The **memory engine** (real Jaccard similarity logic, never called from the pipeline — so internal-link suggestions and duplicate detection never run during a content run)
- **Translation** (a PRD Phase-3 item shipped early)
- **Social repurposing** (LinkedIn + Reddit — which the PRD explicitly lists as a _non-goal_)
- **Image generation**
- **Google Doc export**
- An orphaned **`/projects/new`** page nothing links to

That is six features competing for polish with an editor that silently destroys pasted tables.

**Missing killer features**, ranked by what would actually move purchase decisions:

1. **Publish-then-measure** — you have zero connection between what you publish and what happens to it, and there is no Google Search Console integration despite it being free
2. **Internal linking that actually runs** (the engine exists, it just isn't called)
3. **Content refresh** — find my decaying pages and rewrite them, which is where Clearscope and MarketMuse make their real money
4. **Bulk/CSV runs** for the agency persona the PRD names as target user #1
5. **A real brand-voice model** rather than regex house rules

**Would people pay for it?** For the current build, no — and not because of price. Because the free tier runs on mock providers (advertised in your own hero as "Runs free on mock providers"), so the trial experience produces fake articles about `example1.com`. **You have engineered your top-of-funnel to demonstrate the product not working.**

Fix that one thing and the answer changes: agencies producing 50+ articles/month in niches Jasper refuses to serve would pay, because for them the alternative is a human writer at $150/article.

---

## 02 · Dashboard UX Audit

**Score: 5.0 / 10**

The live-run experience is the best thing in this product and it is not close. Everything around it is a draft.

### What's excellent

`RunView` gets the hardest problem in AI UX right: making a three-minute wait feel like progress. It has a persistent "Step 4 of 8" header, an accordion that folds finished stages into one-line summaries so the page never grows unbounded, per-seat token streaming with cursors, a pinned result card so you never scroll past the article to find the verdict, and — the detail I'd single out — plain-English per-stage copy: _"Reading the pages that rank today," "The AI experts are debating the plan."_ That exists specifically so silent stages never feel frozen.

Underneath, `lib/run.ts` batches SSE deltas into one `requestAnimationFrame` flush to avoid a re-render storm, and implements bounded reconnect on `Last-Event-ID`. This is Linear-tier work.

### Friction points, ranked

#### 🔴 CRITICAL — The rich text editor silently deletes content and autosaves the loss

Content round-trips Markdown → HTML → Markdown on every keystroke through a hand-rolled ~40-line walker. Its fallback is `default: return inner` — keep the text, drop the element.

- Paste a table from Google Docs → **table gone**, flattened to a paragraph
- Nested lists → collapsed into the parent item
- `<sup>`, `<mark>`, `<u>`, footnotes → **destroyed**

Then autosave fires 1.5s later and persists the destruction, with no warning and no undo path.

> `frontend/components/RichArticleEditor.tsx:100-118, :120-137` · autosave at `editor/page.tsx:96-101`

#### 🟠 HIGH — Four competing surfaces run the same pipeline

`/chat`, `/projects/[id]` "Run here", `/journey?run=1`, and `/review` all start the same run. On the project page three of them sit in one button row with no guidance. Two of the four re-implement the SSE wiring by hand instead of using `attachRunStream()` — whose own header comment claims all three surfaces use it. Decision paralysis at the single most important action in the product.

> `frontend/app/projects/[id]/page.tsx:190-204, :80-134` · `journey/page.tsx:80-120` vs `lib/run.ts:113`

#### 🟠 HIGH — Empty states render during loading

`/projects` initialises to `[]` with no loading flag, so every user with projects sees **"No matching projects"** flash before data arrives. `/settings` renders `credits ?? 0`, showing a paying customer **"0 credits left."** The correct fix already exists in `Shell.tsx:141-143` (render `…` while null, with a comment explaining why); Settings and Projects just didn't copy it.

> `frontend/app/projects/page.tsx:14,55-56` · `settings/page.tsx:133`

### Loading states

Nine pages share the identical bare string `<p className="muted">Loading…</p>`. Exactly one page (`/admin`) has skeletons. There is no `loading.tsx` anywhere in the App Router tree. On a dark glass UI, an unstyled 13px grey word is the weakest possible loading affordance.

**Empty run screen.** Your own screenshot shows it: during a live run the stepper sits at the top and the entire main content area is empty. Minutes of blank space. The stage copy is excellent when it renders — the problem is everything below it is void.

### Accessibility

The worst single finding in the frontend: **there is no `:focus-visible` style on any application control.** All five occurrences in 7,265 lines of CSS are on the marketing footer. Worse, two elements actively kill focus with no replacement — including `.rt-editor { outline: none }` on the contentEditable article body, meaning the primary writing surface has no focus indicator at all.

Add to that:

- Zero `aria-live` regions anywhere — the entire SSE run is silent to a screen reader
- Admin table sorting on bare `<th onClick>` with no `tabIndex` or `role` (keyboard-inaccessible)
- Upgrade modal with no `role="dialog"`, no focus trap and no Escape handler
- Placeholder text at 2.9:1 contrast (fails WCAG AA)
- Emoji used as functional iconography throughout
- Twenty of 37 components have zero ARIA attributes
- `.lab-btn { border: 1px solid var(--border) }` — `--border` is never defined in either theme, so it falls back to `currentColor`. A live bug.

### Mobile

Fourteen ad-hoc breakpoints, no system.

- The **pricing comparison table** — your single most important conversion asset — is a 720px-min horizontal scroll strip on a phone with no sticky feature column, so you can't tell which plan a row belongs to
- The chat container uses `100vh` not `100dvh`, so the composer clips under mobile Safari's URL bar
- `.bf-topic textarea:focus { min-height: 24vh }` pushes the "Write my article" button below the fold at the exact moment of intent
- The admin table is a 720px sideways strip with inline credit-edit inputs

---

## 03 · Feature Audit

| Feature                            | Implementation                                                                                                                                     | Weakness                                                                                                                                                     | Enterprise gap                                                                  | Priority     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------ |
| **Keyword research**               | LLM-derived set, then real Ahrefs volume/difficulty re-ranks the primary. Generates plural/singular and "best X" variants and lets real data pick. | Without an Ahrefs key it's pure LLM guesswork. No SERP feature data, no seasonality, no parent topic.                                                        | Keyword lists, clustering, cannibalisation checks, per-market volume.           | **High**     |
| **Competitor analysis**            | Real HTTP fetch of up to 6 ranking pages, headings + 2.4KB prose excerpt each, concurrent, size- and time-capped.                                  | No HTML parser dependency — extraction is regex. **No SSRF guard and follows redirects** (the only egress path in the codebase that does both).              | Rendered-JS fetching, schema extraction, backlink context, content-gap diffing. | **High**     |
| **Council / debate**               | 4 seats, 3 rounds, directed ring pairing, forced DEFEND/CONCEDE/REVISE stance, judge sees full transcript.                                         | Frequently one model in four masks (see §07). "Conflicts" are manufactured, not detected. Output barely reaches the article.                                 | Disclosure of which model actually ran; convergence criteria; cost per seat.    | **High**     |
| **Evidence engine**                | Mines facts from fetched excerpts; _drops any fact whose claimed source domain wasn't actually fetched._                                           | Verifies the domain, not that the sentence appears in that domain's excerpt. Inert by default (`research_provider=mock`).                                    | Span-level attribution, entailment scoring, confidence per fact.                | **High**     |
| **Outline**                        | H1/H2/H3 tree + elements + schema hooks; forces a Quick Verdict and FAQ section.                                                                   | Forcing those two sections makes the AEO score tautological (§07).                                                                                           | SERP-intent-matched templates; competitor heading gap overlay.                  | Med          |
| **Article writer**                 | One LLM call per section, 4 concurrent, per-section word budgets computed in Python (not left to the model).                                       | Anti-fabrication instruction is gated on evidence existing — so it's silent when there is none. Never sees council output.                                   | Brand voice model, style guide enforcement, tone controls.                      | **High**     |
| **Polish + cross-model critic**    | A _different_ provider reviews the draft, names ≤2 weakest sections, triggers targeted rewrites.                                                   | Undersold. This is the highest-value quality mechanism in the product and the marketing ignores it.                                                          | Diff view of what the critic changed and why.                                   | Med          |
| **Fact-check**                     | ~700 lines of careful regex claim extraction with real false-positive suppression (model numbers, scope prices, advice openers).                   | **The inline-citation escape hatch nullifies it.** Verification is Jaccard token overlap at 0.45 — no entailment, no embeddings.                             | Claim-level provenance UI, human review queue, citation export.                 | **Critical** |
| **Scoring + gate**                 | 8 fully deterministic axes, 3 hard blockers, 5 advisories. No LLM vibes.                                                                           | AEO is structurally incapable of failing; Originality is neutralised by your own autofix pass (§07). Gate verdict is never persisted.                        | Score history, per-axis trend, benchmark vs live SERP.                          | **High**     |
| **Compliance / house rules**       | Deterministic per-site rules; autofix is code-fence aware so CLI flags survive the em-dash rule.                                                   | Emits a `typography_lock` violation unconditionally — every run reports ≥1 "violation," training users to ignore the panel.                                  | Per-brand rule editor, approval workflow, rule versioning.                      | Low          |
| **Memory engine**                  | Jaccard similarity + naive stemmer for duplicate detection and internal linking.                                                                   | **Never called from the pipeline.** Purely lexical — no embeddings, so it misses any semantic duplicate.                                                     | Vector store, site-wide topical map, link equity modelling.                     | **High**     |
| **Publishing**                     | WordPress REST + generic webhook, SSRF-guarded at save and publish, gate-enforced.                                                                 | Plaintext credentials. Two entirely different WordPress UIs — one asks for the app password inline per project.                                              | OAuth to WP, Webflow/Ghost/Shopify/HubSpot, scheduling, rollback.               | **Critical** |
| **Analytics**                      | Real per-run token/cost aggregation.                                                                                                               | Traffic, top keywords, AI-citation counts and decay alerts are **SHA-256-seeded fakes**. Panel headings ship internal spec IDs ("Monthly budget (PRD §13)"). | GSC + GA4 integration; real rank tracking; ROI per article.                     | **High**     |
| **Admin panel**                    | Search, sort, paginate, credit adjust, promote, suspend, delete. Self-lockout guards. Only page with skeletons.                                    | **No audit log** for promote/suspend/delete. Sorting is keyboard-inaccessible.                                                                               | Immutable audit trail, RBAC beyond a binary flag, impersonation with consent.   | Med          |
| **Repurpose / translate / images** | All real. Translation has the only proper cache in the codebase (50k LRU).                                                                         | Repurpose covers 2 channels. Translate crosses a documented PRD non-goal boundary. Image docstring is stale (claims DALL·E 3, code uses gpt-image-1).        | Full channel matrix, localisation memory, brand asset library.                  | Low          |

---

## 04 · Workflow Audit

**Click count, signup to published: 9–11.** That is genuinely good — better than Surfer, which makes you create a Content Editor doc, pick a keyword set, wait for the audit, then write. Credit where earned.

| Step                   | Current                                                                   | Clicks | Problem & automation opportunity                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------- | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signup**             | Name / email / password + mandatory Terms checkbox, or Google             |    2–3 | No email verification at all. No onboarding after landing on `/chat` — no welcome, no tour. **Automate:** pre-seed one demo project from a real URL the user pastes at signup.                                                |
| **Project creation**   | Folded into the chat brief. Topic textarea + optional format/length chips |    1–3 | Good design. But `/projects/new` is a fully-built orphan page nothing links to — dead code shipped to users. **Automate:** infer format and length from the topic instead of asking.                                          |
| **Keyword research**   | Automatic inside the run                                                  |      0 | The Ahrefs re-rank is your best SEO feature and it is invisible. **Surface it:** show "we switched your keyword from X (150/mo) to Y (2,500/mo)" as an explicit, overridable decision.                                        |
| **Research**           | Automatic; fetches up to 6 ranking pages                                  |      0 | Defaults to mock, so by default nothing is fetched. **Fix:** default to DuckDuckGo, which needs no key.                                                                                                                       |
| **Outline**            | Automatic; approval optional in gated mode                                |    0–1 | Gated mode is the differentiator and it's buried below the format chips as a mode toggle most users will never find.                                                                                                          |
| **Writing**            | Automatic, streamed, 4 sections concurrent                                |      0 | Strong. No opportunity to intervene mid-write.                                                                                                                                                                                |
| **SEO / optimisation** | Polish + meta pack + 8 scores + gate                                      |      0 | Scores arrive as a verdict, not a workflow. **Automate:** one-click "fix what's failing" that re-runs only the failing axis instead of the whole pipeline.                                                                    |
| **Publishing**         | Editor → SEO fields → Publish                                             |    2–4 | SEO title/meta are generated but must be manually confirmed in three fields. **Automate:** prefill and let the gate flag them, don't make them a form.                                                                        |
| **Analytics**          | Separate page, mostly synthetic                                           |      1 | No loop back to content. **The biggest automation opportunity in the product:** GSC integration → detect decay → auto-queue a refresh run. That is the entire MarketMuse retention story and it's free to build on GSC's API. |

**Unnecessary clicks, specifically:** the four-way run-surface choice on the project page (should be one); the WordPress credential form repeated per project when an account-level connection already exists in Settings; three manual SEO fields in the editor that the pipeline already generated; and "+ New (chat)" as a button label — a parenthetical implementation detail leaking into UI copy.

---

## 05 · UI Design Audit

**Score: 6.5 / 10**

The visual direction — dark aurora, emerald accent, glass surfaces — is genuinely attractive and the hero would not look out of place next to Vercel. The system underneath it has no scale.

### Measured facts

| Dimension                |   Unique values | Should be | Evidence                                                                               |
| ------------------------ | --------------: | --------: | -------------------------------------------------------------------------------------- |
| `font-size`              |          **35** |       6–7 | Includes 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5px — eyeballed, not derived |
| `padding` (single-value) |          **40** |         6 | No spacing scale exists                                                                |
| `gap`                    |          **29** |         6 | No spacing scale exists                                                                |
| `border-radius`          |          **22** |       3–4 | `--radius: 12px` is defined and used **once**                                          |
| Total CSS                | **7,265 lines** |         — | One file, 1,730 rule blocks, 44% of the entire frontend codebase                       |

Five button-ish primitives exist at five different sizes with no shared base: `.btn` 13.5px, `.chip` 13px, `.fchip` 12px, `.rt-btn` 13px, `.lab-btn` 12px. Base `body` font-size is **13px** — small for a product whose entire job is prose. Linear ships roughly a 6-step type scale and a 4px spacing grid; that is the whole difference.

**Theme handling.** Tokens are well-named and semantic, and no-flash theming is done correctly with a pre-hydration script. But ~117 lines are hand-maintained selector lists patching dark-only hex literals, including a block literally titled "Light-mode contrast fixes." Every new component with a hardcoded colour requires appending to those lists. That is a patch backlog, not a theme system.

### Fabricated UI — every instance

This section is the one I'd act on today, because it is a trust problem rather than a taste problem.

#### 🔴 CRITICAL — "Protected by reCAPTCHA" on login and signup — there is no reCAPTCHA

No dependency, no site key, no script tag. Your own CSP doesn't whitelist `google.com/recaptcha`, so it could not load even if it existed. This is a fabricated security claim displayed at the exact moment a user hands over a password. **Delete the line today.**

> `frontend/components/AuthShell.tsx:171`

The rest, in order of how bad they look to a buyer:

- A fake WordPress publish card showing **"spicyranked.com · Connected"** with a green status dot, and "Publish now" / "Schedule" rendered as `<span>` elements styled to look like buttons
- An entire "cockpit" mockup carrying a **"Live"** badge. Nothing in it is live. Confidence values 92/88/90/84 are hardcoded, as are three invented Judge verdicts
- **Three different fake gate scores on one page** — 87 in the hero, 87 in the scoring section, 88 in how-it-works
- A floating stat card claiming **"27 min brief→draft"** while the app's own copy promises **"~3 min."** Two invented durations, 9× apart, in one product
- "All systems normal" with a green dot, styled as a status-page link, pointing at `/contact`. There is no status page
- Social icons with `aria-label="ContentOS AI on X / GitHub / LinkedIn"` — all three `href="/contact"`. Screen readers announce three profiles that don't exist. Careers, Docs, Blog, Changelog and Status point there too
- Analytics panels titled **"Monthly budget (PRD §13)"** and **"Content-decay alerts (FR-12.2)"** — internal requirement IDs shipped as user-facing copy
- Four vendor logos under "Powered by the frontier models" — the strongest trust signal on the page, describing a configuration most users won't be in, since the free tier runs mock adapters. This also carries real **trademark risk**: it reads as endorsement

### Versus the benchmark set

| Product    | What they have that you don't                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Linear** | A strict type and spacing scale; keyboard-first interaction with visible focus everywhere; instant optimistic mutations. You have the loading choreography but none of the input rigour. |
| **Vercel** | Geist as a systematic design language; dashboards that degrade gracefully to mobile as cards, not scroll strips.                                                                         |
| **Notion** | A real block editor with a document model. Your editor is `document.execCommand`, deprecated for years.                                                                                  |
| **OpenAI** | Restraint. No permanently-animating background layers on a text-editing screen.                                                                                                          |
| **Framer** | Marketing pages where the product shots are real product. Yours are hardcoded JSX with a "Live" badge.                                                                                   |
| **Cursor** | Honest capability claims. They don't print a fake status indicator.                                                                                                                      |

---

## 06 · Information Architecture

**Current nav:** New chat · Chat · Dashboard · Projects · Analytics · Settings. Six flat items.

**Would an enterprise user understand it?** No, for two reasons. First, "Chat" and "Projects" are the same object at different stages — a chat _becomes_ a project, but the nav presents them as peers, and the Recent list in your own screenshot shows four identically-named entries with no dedupe or date grouping. Second, the concept an agency actually organises around — **the site** — does not exist in the IA at all. Website is a field on a project, not a container. The memory engine already keys on `website`; the navigation doesn't.

**Can it scale to 100+ features?** Not as-is. Six flat items with no grouping is already straining, and API routes are fragmented across nine routers all mounted at `/api/projects` with auth re-declared per router — which is precisely why five of them forgot it.

### Proposed navigation tree

```
Workspace ▾                    ← org switcher (enterprise multi-tenant)
│
├── Sites                      ← THE missing primitive
│   └── example.com
│       ├── Overview           traffic, decay alerts, coverage
│       ├── Content            all articles for this site
│       ├── Topic map          clusters, gaps, cannibalisation
│       ├── Internal links     the memory engine, finally wired up
│       └── Connections        WordPress / webhook / GSC
│
├── Create
│   ├── New article            the current chat brief
│   ├── Bulk run               CSV in, N articles out  (agency persona)
│   └── Refresh queue          decayed pages needing a rewrite
│
├── Library
│   ├── Articles               filter by site / stage / score
│   ├── Briefs & templates
│   └── Brand voice & rules    house rules, per site
│
├── Insights
│   ├── Performance            GSC-backed, real numbers only
│   ├── Quality                score trends over time
│   └── Spend                  real cost per article
│
└── Settings
    ├── Account · Team & roles · Billing
    └── AI providers & keys
```

Three structural changes matter more than the tree itself:

1. Introduce **Site** as a first-class container
2. Collapse the four run surfaces into one
3. Version the API at `/api/v1` and mount every project sub-router under a single parent that carries `require_project_access`, so a new router physically cannot forget the check

---

## 07 · AI Workflow Audit

**Score: 6.0 / 10**

Ten stages, roughly **2N + 21 + K** LLM calls per article — about 41–50 for a ten-section piece. The orchestration is more sophisticated than most funded competitors ship. It is also uncached, unbudgeted, and 90% unmetered.

### Pipeline stages

|   # | Stage         | LLM calls | What happens                                                                                    |
| --: | ------------- | --------: | ----------------------------------------------------------------------------------------------- |
|   1 | `keywords`    |         1 | Derive primary/secondary/longtail/intent, then optional real Ahrefs re-rank                     |
|   2 | `competitors` |       1–3 | SERP → fetch ≤6 ranking pages → extract evidence bank                                           |
|   3 | `council`     |        14 | R1: 4 seats concurrent; R2: pairwise rebuttal; R3: pairwise reply; judge deliberation + verdict |
|   4 | `outline`     |         1 | H1/H2/H3 tree + elements + schema hooks                                                         |
|   5 | `article`     |         N | One call per section, 4 concurrent                                                              |
|   6 | `polish`      |   N+1…N+4 | Rewrites + cross-model critic + ≤2 critique fixes + SEO meta                                    |
|   7 | `factcheck`   |         K | Regex claim extraction (0 LLM), then K remediation rewrites                                     |
|   8 | `scoring`     |         0 | 8 deterministic heuristics                                                                      |
|   9 | `gate`        |         0 | 3 hard conditions                                                                               |
|  10 | `compliance`  |         0 | Regex house rules                                                                               |

### Prompt architecture

Genuinely strong. The writer system prompt states an "iron rule" — every figure must come from the verified-facts list, _"a number that is not in the facts list DOES NOT EXIST for you"_. Seat prompts demand grounding (_"a recommendation that could apply to any article on any topic is worthless"_). The critic prompt casts a rival publication's reviewer. These are well-written.

The problem is enforcement, not instruction. And in the default configuration the enforcement is **inverted**: the hard guard _"NO VERIFIED FACTS exist for this section, therefore do NOT name specific products, prices or figures from memory"_ is gated behind `evidence_exists == True`. When a run has zero evidence — the default, since `research_provider=mock` skips page fetching entirely — neither the facts list nor the warning is emitted. **The anti-fabrication instruction is silent precisely when there is nothing to ground the model.**

### The council: what's real, what's theatre

**Real:** four distinct role prompts on distinct optimisation axes, streamed concurrently; a directed ring so each seat critiques exactly one named rival; a forced one-word stance token; and a judge that receives the _full_ transcript including every rebuttal, streams its deliberation, then rules in strict JSON. There's a code comment noting the old judge only saw opening statements — that was found and fixed. This is a real protocol.

#### 🟠 HIGH — It is frequently one model wearing four masks, and nothing discloses it

When a seat's provider has no API key, `get_adapter` silently borrows the first keyed provider instead. With only an Anthropic key configured, all four "debating models" _and_ the judge are the same Claude model with different system prompts. That is self-play, not a multi-model council — and it is the product's single biggest marketing claim.

It gets worse in the reporting: the orchestrator yields the **requested** provider name, not the one that executed. So a seat mapped to Google but run on Anthropic surfaces in the UI as `provider="google", model="claude-opus-4-8"`, is stored that way on `AgentRun`, and is priced with **Google's rate card for an Anthropic call**.

**Fix:** Yield `adapter.provider`. Log a warning on substitution. Show a seat badge in the UI reading "ran on Anthropic (no xAI key)". Honesty here is cheap and the alternative is a refund conversation.

> `backend/app/providers/factory.py:70-76` · `council/orchestrator.py:290-295` · `pipeline/service.py:455,461`

#### 🟡 MEDIUM — "Conflicts" are manufactured, not detected

Every rebuttal turn with non-empty text unconditionally becomes a conflict record, and the rebuttal prompt _requires_ disagreement. So the conflict count always equals the seat count, and there is no possible run where the council reports "we agreed." A constant dressed as a signal. Self-reported confidence (default 0.7) is likewise never weighted into any decision.

> `backend/app/council/orchestrator.py:755-761, :70-102`

**And the debate barely reaches the article.** Only two artifacts leave the council: a strategy summary and decisions filtered to `accepted`/`merge`, which shape H2 selection. The writer never sees any of it. Fourteen LLM calls produce a bullet list.

### Orchestration mechanics

| Concern               | State                    | Consequence                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retry**             | SDK `max_retries=1` only | No backoff, no jitter, no 429 handling, no circuit breaker. A rate-limit becomes a silent degradation to fallback prose.                                                                                                                                                                                                                                                                |
| **Timeouts**          | One global 60s           | Same budget for a 40-word FAQ polish and a 2,000-word section with `max_tokens=16000`. Long sections time out under load.                                                                                                                                                                                                                                                               |
| **Caching**           | **Zero**                 | No response cache, and no Anthropic `cache_control` despite an ideal shape: a ~6.5KB research digest resent across 14 council calls, a ~2.5KB system prompt resent per section. **This is the largest avoidable cost line in the product — a straightforward 40–70% input-token reduction.**                                                                                            |
| **Streaming**         | Excellent                | Real token streaming on all adapters; failover deliberately restricted to _before the first token_ so text never swaps mid-stream. Considered design.                                                                                                                                                                                                                                   |
| **Parallelism**       | 4-way at four stages     | Good, but no global concurrency budget and no backpressure — worst case four threads × 16k-token requests at one provider.                                                                                                                                                                                                                                                              |
| **Cost tracking**     | **~10% of spend**        | Only council round-1 is priced. Debate turns, both judge calls, keywords, evidence, outline, all N section writes, all N polish calls, critic, meta and fix rewrites are never counted. Budget ceilings are display-only — nothing enforces them.                                                                                                                                       |
| **Token budgeting**   | None                     | `max_tokens=16000` at every call site; adaptive thinking enabled unconditionally, including on 40-word polishes. No temperature or seed anywhere, so keyword sets, meta packs and evidence banks are non-reproducible run to run.                                                                                                                                                       |
| **Structured output** | Inconsistent             | Two robust parsers exist in-repo (fence-stripping + balanced-brace fallback). **Eight of ten JSON call sites use bare `json.loads`** against a default provider with no native JSON mode. One markdown fence silently downgrades keyword research, the evidence bank, the critic and the meta pack to heuristics — with no log line. The fix is importing a function you already wrote. |
| **Model selection**   | Static                   | No cost-based routing. Claim grading, meta packs and translation all get the same top-tier model as the article.                                                                                                                                                                                                                                                                        |

### Scoring and gate

Eight deterministic axes, zero LLM vibes — a real strength. Gate blocks on three hard conditions only: `publish ≥ 85`, `fact > 80`, and zero high-risk unsupported claims. Two axes are broken:

- **AEO is tautological.** The outline builder _guarantees_ a "Quick Verdict" and a "Frequently Asked Questions" section on every article. The AEO score measures whether those markers are present. It is structurally incapable of failing.
- **Originality is pre-neutralised.** The penalty term looks for AI-marker phrases and em-dashes — and your own `autofix_text` strips exactly those, on every section, _before_ scoring runs. The penalty is always ~0, so "originality" reduces to a type/token ratio while carrying 6% of the publish weight.

Also: because sampling is non-deterministic, the same brief can land either side of `publish ≥ 85` across runs, flipping the project between `ready` and `editor`. And the gate verdict is computed but **never persisted** — only the score row is — so you cannot audit after the fact why a given article passed.

---

## 08 · Content Workflow Audit

**Can it generate a world-class article? Today, with the default configuration: no.** With `research_provider` set to a real value and the fact-check loophole closed: it could produce genuinely good mid-market content — better than Jasper, competitive with Surfer's output, short of a specialist human.

| Stage               | Grade  | Assessment                                                                                                                                                                                         |
| ------------------- | :----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyword research    | **B**  | Real Ahrefs volume/difficulty re-ranking with variant generation. Strong. Invisible to the user.                                                                                                   |
| SERP analysis       | **C**  | Real when configured (DuckDuckGo scrape, Brave API, or hybrid with LLM web-search). **Defaults to fabricated `example1.com` results.** No SERP features, no People-Also-Ask, no snippet targeting. |
| Competitor analysis | **B−** | Genuinely fetches and parses ranking pages. Regex extraction, no rendered JS, 6-page cap.                                                                                                          |
| Intent analysis     | **C−** | One LLM field. No SERP-type classification, no intent-to-format mapping.                                                                                                                           |
| Outline             | **B**  | Full H1/H2/H3 tree with elements and schema hooks, sized against real competitor depth.                                                                                                            |
| Writing             | **B**  | Per-section generation with Python-computed word budgets. Solid.                                                                                                                                   |
| SEO optimisation    | **B−** | Polish pass, meta pack, 8 scores. No live-SERP benchmark, no term-frequency targets.                                                                                                               |
| Readability         | **C+** | Scored (avg sentence length + length), enforced only as an advisory.                                                                                                                               |
| E-E-A-T             | **D**  | Measured as % of claims with _a_ source — and the source needn't exist. No author entity, no bio, no credentials, no first-hand experience signals, no `sameAs`.                                   |
| Fact checking       | **D**  | Careful extraction, real false-positive work, then nullified by the inline-citation escape. Jaccard overlap, no entailment.                                                                        |
| Plagiarism          | **F**  | **Does not exist.** No Copyscape, Originality.ai, or internal similarity check against the fetched competitor pages — which is notable, because you already have those pages in memory.            |
| Internal linking    | **F**  | Engine written, never called from the pipeline. Purely lexical when it is called.                                                                                                                  |
| Schema              | **C**  | JSON-LD export exists and outline carries schema hooks. No FAQPage/HowTo/Product/Review variants, no validation.                                                                                   |
| Publishing          | **B−** | WordPress + webhook, gate-enforced, SSRF-guarded. Plaintext credentials.                                                                                                                           |

### Missing steps a world-class pipeline has

1. **Plagiarism / near-duplicate check** against the fetched competitor corpus. You have the text already; a shingle-based similarity pass is a day's work and closes a real legal exposure.
2. **Author entity and E-E-A-T scaffolding** — byline, credentials, `Person` schema with `sameAs`, review date. Google's helpful-content guidance is explicit about this and you score E-E-A-T without modelling any of it.
3. **First-hand experience signals** — the "E" that was added to E-A-T. No testing methodology, no original data, no images with EXIF.
4. **Image alt text and captions** generated per section rather than one hero image.
5. **Internal link insertion** during writing, not as an afterthought.
6. **SERP feature targeting** — featured snippet paragraph shape, list-block sizing.
7. **Post-publish verification** — fetch the live URL and confirm the rendered HTML matches what you published.

---

## 09 · SEO Engine Audit

**Score: 6.0 / 10**

| Capability             | State                                                                 | Gap vs Surfer / Clearscope                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title & meta           | Generated as an SEO meta pack                                         | No pixel-width check, no CTR modelling, no A/B variants                                                                                                                     |
| Headings               | Full H1/H2/H3 tree, depth matched to competitor median                | No heading-gap diff vs the actual top 10                                                                                                                                    |
| Entities               | Extracted; 25% of the SEO score                                       | No entity salience, no knowledge-graph linkage, no `sameAs`                                                                                                                 |
| **Semantic SEO / NLP** | Token coverage + entity presence                                      | **The core gap.** No TF-IDF, no term-frequency targets, no LSI set, no embeddings. Surfer's entire product is "use these 40 terms N times each" and you have no equivalent. |
| Content score          | 8 deterministic axes — genuinely better designed than a single number | Not benchmarked against live SERP competitors, so the number is absolute rather than relative                                                                               |
| Topical authority      | **Absent**                                                            | No site-level topic coverage model                                                                                                                                          |
| Topic clusters         | **Absent**                                                            | No pillar/spoke planning — MarketMuse's whole business                                                                                                                      |
| Internal linking       | Engine exists, never invoked                                          | No link graph, no anchor optimisation, no orphan detection                                                                                                                  |
| Schema                 | JSON-LD export + outline hooks                                        | No type variants, no validator                                                                                                                                              |
| Content freshness      | Year-refresh in derived keywords only                                 | No decay detection (analytics alerts are synthetic), no refresh queue, no GSC                                                                                               |
| Gap analysis           | **Absent**                                                            | Competitor headings are fetched and then not diffed against your outline — the data is already in memory                                                                    |

Two things here are cheap and would move the product materially:

**First, the heading gap diff.** You fetch six competitors' heading structures and never compare them to your own outline. Rendering "4 of 6 competitors cover X; your outline doesn't" is pure computation on data you already have.

**Second, term-frequency targets.** Extract the top 30–40 terms by TF-IDF across the fetched pages, show target ranges, score against them. That is Surfer's core feature and you are one function away from a credible version of it, because you already have the corpus.

---

## 10 · Competitive Analysis

| Competitor                  | Their core strength                                                      | You vs them                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SurferSEO** (~$99+/mo)    | NLP term targets, live content score against the actual SERP, huge brand | **Behind.** No term-frequency engine at all. **Ahead** on end-to-end automation — Surfer optimises a draft you wrote; you produce the draft.                                                                          |
| **Clearscope** (~$170+/mo)  | Best-in-class term relevance, enterprise trust, clean reports            | **Well behind** on term modelling and polish. **Ahead** on price and on producing the content itself.                                                                                                                 |
| **Frase** (~$45+/mo)        | SERP research + AI writing, closest direct analogue                      | **Comparable** pipeline; **ahead** on the debate/gate concept; **behind** on maturity, integrations and the fact that they can charge money.                                                                          |
| **MarketMuse** (~$149+/mo)  | Topic modelling, content inventory, personalised difficulty              | **Far behind.** You have no site-level topic model — their entire moat. Nothing in your product plans a cluster.                                                                                                      |
| **NeuronWriter** (~$23+/mo) | Cheap NLP recommendations, SERP analysis                                 | Your closest price competitor. They have the semantic layer you lack; you have the multi-model gate they lack.                                                                                                        |
| **Semrush / Ahrefs**        | The data itself — index, backlinks, rank tracking                        | Not competitors, **suppliers**. You already call the Ahrefs API. Never try to out-data them.                                                                                                                          |
| **ChatGPT / Gemini**        | Free-to-cheap, universal, improving weekly                               | **The real threat.** A $20/mo ChatGPT with web search writes a decent article. Your defensible answer must be the things a chat window cannot do: publish gates, evidence provenance, WordPress delivery, and volume. |
| **Perplexity**              | Citation-first research UX                                               | They've made source attribution table stakes. Your evidence engine is closer to their standard than any SEO tool — and you don't show sources in the article UI.                                                      |

**Missing vs the field:** NLP term targets · topic clusters and site-level authority modelling · rank tracking · content inventory and audit · SERP feature targeting · plagiarism detection · team roles and collaboration · a public API · integrations beyond WordPress · Chrome extension / Google Docs add-in · anything resembling billing.

**Where you are genuinely ahead:** Multi-model adversarial review with a visible transcript · a hard, deterministic publish gate rather than an advisory score · an evidence bank keyed to pages that actually rank · permissive-provider routing for restricted niches (nobody else will touch this) · a durable, reconnectable run architecture · brief-to-published in one pass · price.

---

## 11 · Database & Backend Architecture

**Architecture: 5.0 / 10 · Scalability: 3.0 / 10**

### What's well built

Three things here are above the median for funded teams, not just solo builds.

- **The credit charge is a correct conditional atomic UPDATE** (`WHERE credits >= cost`, decided by rowcount) — most codebases at this stage have a read-then-write double-spend.
- **Migration discipline is real:** 13 revisions, single linear head, no branches, every one with a working downgrade, `render_as_batch` and `compare_type` set.
- **The SSE tail architecture** decouples the run from the connection, replays from offset with no await gap (a correct and non-obvious race fix), honours the browser's native `Last-Event-ID`, and releases the DB session before streaming. Most products in this category run the pipeline inside the request and lose everything on a tab close.

### Database

16 tables, UUID PKs, sane FKs. Problems, in order:

- **JSON-blob abuse is systemic and now load-bearing.** `research` alone has eight JSON columns holding the SERP, competitor page dumps and the entire evidence bank; `draft.sections` holds the whole article. On Postgres these are `JSON`, **not `JSONB`** — no GIN index, no operators, re-parsed on every read. You cannot answer "which projects cite domain X" without a full scan.
- **`project.owner_id` is nullable**, with a "legacy pre-auth rows" carve-out honoured in _every_ authorization check. Any row with a null owner is readable and runnable by every authenticated user — a permanent open door left for a handful of dev rows.
- **Naive timestamps.** Columns are `DateTime` without `timezone=True` while values are produced tz-aware, so SQLAlchemy silently drops the tzinfo. Two modules hand-roll `.replace(tzinfo=None)` to work around it, and the monthly credit refill compares months in an ambiguous local frame.
- **No DB-level cascades, no CHECK constraints.** All cascades are ORM-only; admin user deletion loops projects manually. Every status/stage/label/plan field is free-form text validated only in Python.
- **Missing composite indexes for the actual queries.** "Latest draft" is `(project_id, version DESC, created_at DESC)`, run in at least four places; only `project_id` is indexed. `debate_turn.seq` is ordered on and unindexed. `usage.run_id` and `credit_ledger.project_id` are bare strings, not foreign keys.

### Scalability — the hard ceiling

#### 🔴 CRITICAL — `WEB_CONCURRENCY=1` is architecturally mandatory, not a tuning choice

The SSE hubs are module-level process dicts. The rate limiter is in-process. Generated media is on local disk (ephemeral on Render — **lost on every deploy**). Two workers means broken reconnect, double the rate limit, and a boot-time reaper on instance B killing instance A's live runs. **You cannot add a second process without breaking correctness.**

Background jobs are bare `threading.Thread(daemon=True)` — no queue, no broker, no retry, no dead-letter, no concurrency cap, no backpressure. N users means N daemon threads each holding a DB session through minute-long LLM calls. On SIGTERM they die mid-transaction inside a 30-second graceful timeout. The PRD specified Celery + Redis; it was never built.

**Fix (sequenced):** Redis first — it solves three problems at once: distributed rate limiting, a shared pub/sub bus for SSE fan-out across workers, and a broker. Then move the pipeline into an `arq` or RQ worker process. Then move media to S3/R2. Only then raise `WEB_CONCURRENCY`. Roughly two weeks, and it is the difference between 1 concurrent run and 100.

> `render.yaml:32-33` · `pipeline/hub.py:111,215-221,174-188` · `ratelimit.py:58` · `media/router.py:24,71,104`

### API design

- **No versioning anywhere** — everything is `/api/...` with no escape hatch for breaking changes
- Nine routers mount at `/api/projects` with auth re-declared per router
- Four different pagination conventions across four endpoints
- Error format is inconsistent: mostly `{"detail": str}`, but the publish gate returns a nested object, and **SSE errors return HTTP 200** with an error frame — so "please sign in" and "project not found" both come back as 200, defeating client and proxy error handling
- **Zero idempotency.** No `Idempotency-Key` anywhere, and both credit-charging endpoints do irreversible work. Worse, the council re-run charges credits, _then deletes all prior council artifacts_, then runs for minutes — a crash in between leaves the user charged with their transcript destroyed and nothing to show

### Observability

Close to nonexistent. Plain `basicConfig` logging with no JSON, no request ID, no correlation ID, no user ID on any line. No metrics of any kind — you cannot answer "how many runs failed today" or "p95 stage latency" without SQL archaeology. No error tracking. And **no audit log for admin actions**: promote, suspend, and account deletion (which destroys all their work) leave zero durable trace. Health and readiness probes are correct and wired — that is the one part done right.

---

## 12 · Performance Audit

**Score: 5.0 / 10**

**The frontend is a CRA-era SPA in App Router clothing.** 36 of 37 components are `"use client"`; the only server component is the root layout. No page does server-side data fetching. There is no `loading.tsx`, no `error.tsx`, no Server Actions, no `generateMetadata`, no streaming SSR. You pay the React Server Components bundle cost for zero benefit — and even the fully static marketing pages ship as client components, including a 1,319-line landing page rendered in the browser.

| Area              | Finding                                                                                                                                                                                                              | Fix                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Data fetching** | Raw `fetch` in `useEffect`. No cache, no dedupe, no revalidation. `Shell` refetches the project list on _every navigation_, while the page fetches it again — duplicate concurrent requests on every dashboard load. | SWR or React Query. One dependency, removes the whole class.               |
| **Waterfalls**    | `/review` does three sequential round-trips before first paint.                                                                                                                                                      | `Promise.all`, or move to a server component.                              |
| **State**         | The editor holds **30 `useState` hooks in one component**. Cross-component sync uses a raw DOM `CustomEvent`.                                                                                                        | `useReducer` or a small store.                                             |
| **Editor**        | Fires a **full network re-score every 600ms while typing.**                                                                                                                                                          | Score on blur or explicit request, not per keystroke.                      |
| **CSS**           | 7,265 lines shipped on every page including the marketing site.                                                                                                                                                      | CSS Modules or a build step; split marketing from app.                     |
| **Background FX** | Three fixed full-viewport animated layers (aurora, particles, curtain) run permanently on _every_ page including the editor — a continuous GPU cost on a text-editing surface.                                       | Restrict to marketing routes. Reduced-motion is already handled correctly. |
| **Bundle**        | Nothing to trim — only Next/React are installed. Genuinely lean.                                                                                                                                                     | —                                                                          |
| **DB queries**    | Cost aggregation is correctly a single grouped query rather than N+1 — good. But JSON blobs are re-parsed on every read and the "latest draft" query has no composite index.                                         | JSONB + composite indexes.                                                 |
| **LLM caching**   | **None.** The single biggest performance _and_ cost lever in the product.                                                                                                                                            | Anthropic `cache_control` on the research digest and system prompts.       |
| **Metadata**      | No OG tags, no Twitter card, no favicon, no manifest. Sharing any page produces a blank card.                                                                                                                        | An hour's work; meaningful for a product that sells SEO.                   |

The one genuinely excellent performance decision: SSE token deltas are buffered and flushed once per `requestAnimationFrame`, with the reasoning written down in a comment. That is the kind of thing most teams discover only after a profiling session.

---

## 13 · Security Audit

**Score: 3.0 / 10**

Some primitives here are better than most startups ship. The boundaries around them are not.

### Done well

- **Password hashing:** PBKDF2-HMAC-SHA256 at 210,000 rounds with a 16-byte random salt and `compare_digest` verification. Matches OWASP guidance. The round count is encoded in the hash so rotation is possible — though no rehash-on-login is implemented, so raising it later never upgrades existing users.
- **Login is timing-safe against account enumeration** via a module-level dummy hash. Most implementations miss this.
- **SSRF guard** resolves all addrinfo entries and rejects anything non-global, with a reasoned comment on why NAT64 is deliberately allowed. Called at both save-time and publish-time.
- **Secrets management:** JWT secret and API key auto-generated by the platform, prod fails fast on SQLite or missing secrets, only `.env.example` is tracked in git.
- **XSS is taken seriously across three renderers** — URL scheme allowlisting, a markdown renderer with no `dangerouslySetInnerHTML` at all, explicit attribute-injection escaping, and an image extension whitelist applied at _both_ call sites.
- **The BFF proxy is textbook:** the API key is injected server-side and never reaches the browser, paired with a real CSP, HSTS and `frame-ancestors 'none'`.

### Broken

#### 🔴 CRITICAL — Multi-tenant isolation fails in five places

Detailed in §00. The pattern — `require_project_access` as a router-level dependency — is correct and airtight in the eight routers that use it. Every isolation bug is a router that didn't.

#### 🔴 CRITICAL — Prompt injection flows from competitor pages into published articles

Up to 2,400 characters of prose from six attacker-influenceable ranking pages are interpolated _directly_ into an LLM prompt with no escaping and no injection screening. The `domain` and `title` are also page-controlled, so an attacker can forge a fake section boundary. The output becomes the evidence bank — described in your own model comment as "the writer's only allowed source of figures."

**A competitor who ranks for your customers' keywords can inject text that becomes cited evidence in their published articles, including attacker-chosen source URLs.**

**Fix:** Escape or strip delimiter sequences from excerpts, wrap each in a clearly-fenced untrusted block, add an explicit instruction-hierarchy preamble, and run a cheap injection classifier over excerpts before they enter the prompt. Also validate that `domain` matches the fetched URL rather than trusting the page.

> `backend/app/research/evidence.py:92-103` ← `fetcher.py:79-97`

#### 🟠 HIGH — 30-day JWTs with no revocation; suspension doesn't end a session

No `jti`, no denylist, no token version. Logout is client-side only. A stolen token is valid for a month, full stop. And the SSE path resolves the user without checking `is_active` — so a **suspended user can still start runs and be charged**. The token also travels in a query string (EventSource can't set headers), landing in access logs and browser history. A hardcoded dev secret is used whenever `APP_ENV` isn't exactly `prod` — so a staging deploy signs tokens with a public constant.

**Fix:** Short-lived access token (15–30 min) + refresh token; a `token_version` column bumped on logout, password change and suspension; and a single-use 60-second stream ticket instead of the session JWT in the URL.

> `backend/app/security.py:34,73-74,88-105` · `pipeline/router.py:36-47,111`

#### 🟠 HIGH — The competitor fetcher has no SSRF guard and follows redirects

It is the _only_ egress path in the codebase that does both — every other one disables redirects and calls the guard. A legitimate ranking page redirecting to `http://169.254.169.254/latest/meta-data/` reaches cloud instance metadata. Separately, the existing guard has a classic TOCTOU: it resolves DNS, then httpx resolves again independently, and the attacker controls the TTL.

**Fix:** Call `guard_ssrf` in the fetcher and set `follow_redirects=False` (or validate each hop). For the TOCTOU, use a pinned-IP transport so the connection goes to the address you actually checked.

> `backend/app/research/fetcher.py:152-161` · `net.py:19-37`

#### 🟡 MEDIUM — Rate limiting is bypassable in one header

`X-Forwarded-For`'s first element is trusted unconditionally with no trusted-proxy check — so any client gets a fresh bucket by sending a random value. That is the exact bucket protecting login and signup from brute force. The limiter is also in-process (resets on restart, doesn't survive scaling) and fixed-window (2× burst at the boundary).

Coverage gaps: the WordPress and webhook _test_ endpoints are unlimited and each makes an outbound request to a user-supplied host — a free, unmetered HTTP scanner.

Also: because the middleware is registered after CORS but Starlette prepends, the rate limiter runs _outside_ CORS, so 429 responses carry no CORS headers and browsers show an opaque network error instead of your message. The code comment asserts the opposite ordering.

> `backend/app/ratelimit.py:58,67-68,27-31` · `main.py:88-98`

### Also worth fixing

- `/docs` and `/openapi.json` are publicly enumerable in production, exposing every admin route and parameter
- CORS defaults to `localhost:3000` and the real value is left unset until a human fills it in post-deploy
- `ProjectCreate` string fields have no `max_length` while the DB columns do — on Postgres that's a 500, not a 422
- `council_config` is an arbitrary user-controlled JSON blob written straight to the DB and later read back _as trusted config_

---

## 14 · Pricing Audit

**Score: 2.5 / 10**

| Plan     | $/mo | Credits | Articles/mo | Cost/article | Verdict                                                                                                       |
| -------- | ---: | ------: | ----------: | -----------: | ------------------------------------------------------------------------------------------------------------- |
| Free     |    0 |     500 |         ~25 |            — | **Actively harmful.** Runs on mock providers — the trial produces fake articles about example1.com.           |
| Pro      |   29 |   5,000 |        ~250 |        $0.12 | **Catastrophically underpriced.** 250 articles/month for $29 while Surfer charges $99 for a fraction of that. |
| Business |   99 |  25,000 |      ~1,250 |        $0.08 | Same problem, larger. Volume is priced _down_ when your marginal cost is flat.                                |

Three structural problems beyond "you can't take payments":

**1. Free tier demonstrates failure.** "Mock providers, zero API spend" is listed as a _feature_ and printed in your hero trust bar. A prospect's first article cites `example1.com`. No conversion follows from that.

**2. Pro is unprofitable-shaped even though you bear no inference cost.** Pro says "bring your own AI keys" — so the customer pays for tokens, and $29 buys them orchestration. That's defensible. But then _why_ is it metered in credits at all? You've built consumption pricing for a cost you don't incur, which caps your revenue at exactly the moment a customer gets value. Meanwhile the credit estimate is charged up front and never reconciled against actual spend, so it is neither a real cost pass-through nor a clean subscription.

**3. The credit unit is invisible.** "1 credit ≈ 1 US cent of budgeted spend" is an internal accounting concept exposed as the customer's mental model. Nobody buys 5,000 of anything.

### Recommended pricing

| Plan           |   $/mo | Includes                                                                      | Rationale                                                                                                                               |
| -------------- | -----: | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Free trial** |      0 | 3 articles on _real_ providers, on your keys. No card.                        | Costs you ~$1.50. Buys a prospect who has seen the product work. **This single change matters more than every other pricing decision.** |
| **Starter**    |     49 | 20 articles/mo · 1 site · WordPress · all scores                              | Undercuts Surfer meaningfully without signalling "toy."                                                                                 |
| **Pro**        |    149 | 75 articles/mo · 5 sites · gated mode · fact-check report · GSC               | Anchor tier. Priced against Clearscope's $170 with more delivered.                                                                      |
| **Agency**     |    399 | 300 articles/mo · unlimited sites · team roles · bulk CSV · API               | Your PRD's primary persona. Currently has no tier built for them.                                                                       |
| **Enterprise** | Custom | SSO · audit log · SLA · dedicated routing · restricted-niche compliance · DPA | Needs the security work in §13 before it can be sold at all.                                                                            |

Price in **articles**, not credits. Overage at a flat per-article rate. Keep BYO-keys as a discount lever, not as the Pro tier's identity.

---

## 15 · Business Audit

**Score: 2.0 / 10**

Let me be blunt: **the PRD contains no pricing, no business model, no unit economics, no go-to-market, and no competitor analysis.** Its success metrics are entirely product-side — average score ≥88, fact >85, <30 min brief-to-draft. Not one revenue or customer target. All four open questions are technical. A 393-line product spec with zero commercial content is the clearest signal in this repository about where the risk actually sits, and it isn't in the code.

**Target audience.** Well-chosen and specific: high-volume multi-site content operations, explicitly including restricted niches where mainstream tools refuse or dilute output. Four personas are named. This is the strongest part of the spec.

**Product-market fit.** Unknown, and unknowable from here — there are no users, no payments, and no usage data. The persona choice is sound; the trial experience actively prevents validating it.

**Differentiation.** Real on paper: structured disagreement, a hard publish gate, evidence-anchored writing, permissive routing. Three of those four are weakened by the implementation (the council is often one model; the gate is passable by regex; evidence is off by default). The fourth — restricted-niche routing — is intact, unusual, and genuinely defensible.

**Retention.** This is the deepest strategic problem and nobody has named it. **Content generation is transactional; content _management_ is retentive.** A user who generates 20 articles has no reason to return next month unless the product holds something they can't get elsewhere: their site's topic map, their performance history, their refresh queue, their brand voice. You have none of that. MarketMuse and Clearscope retain on inventory and topic models. Right now your churn driver is that a competitor's free trial does the same job on day one.

**The AI moat.** Thin, and honestly assessed: prompt architecture and orchestration are copyable in weeks by a competent team. The durable assets you could build are:

1. The evidence corpus accumulated across runs — which you currently throw away
2. Per-site memory and topic graphs
3. A golden-set eval harness that lets you improve quality measurably while competitors guess

Notably, commits reference an "espresso quality test" and a "rank-worthiness test" — **neither is in the repository.** Your highest-signal quality gate lives outside version control.

### Risk register

| Risk                             | Severity     | Detail                                                                                                                                                                                             |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No revenue mechanism             | **Critical** | Cannot charge. Everything else is theoretical until this is fixed.                                                                                                                                 |
| Security breach                  | **Critical** | Plaintext WordPress credentials + cross-tenant reads. One incident ends the company and is individually notifiable under GDPR.                                                                     |
| Fabricated content published     | **Critical** | The inline-citation loophole means a customer can publish an invented statistic attributed to a real publication. That is a defamation and advertising-standards exposure, not just a quality bug. |
| Foundation-model commoditisation | High         | Every capability improvement at OpenAI/Anthropic erodes the orchestration premium.                                                                                                                 |
| Google policy                    | High         | Mass-produced AI content is squarely in scope for spam policy updates. Your gate is a partial answer; make it the whole pitch.                                                                     |
| Restricted-niche concentration   | Med          | Differentiating and dangerous. Payment processors decline adult-adjacent merchants — which will complicate the Stripe integration you haven't built yet. Plan for it now.                          |
| Trademark exposure               | Med          | Four vendor logos under "Powered by the frontier models" reads as endorsement. Add a disclaimer or drop the marks.                                                                                 |
| Single-person bus factor         | Med          | 15 commits, one author, docs that describe a system that no longer exists.                                                                                                                         |

**Revenue potential.** Realistically: at corrected pricing, 200 paying customers averaging $120/mo is ~$290k ARR — a credible solo-founder outcome in 18 months _if_ payments ship, the trial uses real providers, and the security work lands. The path to $5M+ requires the retention layer (sites, topic maps, refresh queues) that does not exist yet.

---

## 16 · Roadmap

### 30 days — stop the bleeding

| Priority     | Item                                      | Detail                                                                                                                                                                           |
| ------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Critical** | Close the five tenant-isolation holes     | Filter portfolio analytics by owner; add `require_project_access` to export, media, analytics and memory routers. Add a test that asserts user B gets 404 on every user-A route. |
| **Critical** | Encrypt WordPress + webhook credentials   | Fernet from `CREDENTIAL_KEY`, migration re-encrypts existing rows.                                                                                                               |
| **Critical** | Close the inline-citation loophole        | Require the cited name to match a real fetched source. Add the fabricated-outlet regression test.                                                                                |
| **Critical** | Delete every fabricated UI claim          | reCAPTCHA line, "All systems normal," fake social links, the "Live" badge on a static mockup, contradictory 27min/3min and 87/88 numbers, PRD section IDs in analytics headings. |
| **Critical** | Ship Stripe Checkout                      | Webhook into the existing `set_plan` path. Flip `PAYMENTS_ENABLED`.                                                                                                              |
| **High**     | Refund credits on failure                 | Three call sites: worker except-block, reaper, gate-block. Ledger already supports the reason.                                                                                   |
| **High**     | Real providers on the free trial          | 3 articles on your keys. Kill mock-provider marketing.                                                                                                                           |
| **High**     | Default `research_provider` to DuckDuckGo | One config line. Turns on every anti-hallucination mechanism you already built.                                                                                                  |
| **High**     | Global `:focus-visible` ring              | ~10 lines of CSS. Currently the app is unusable by keyboard.                                                                                                                     |
| **High**     | SSRF guard on the competitor fetcher      | Call the existing guard; disable redirects.                                                                                                                                      |

### 90 days — make it sellable

- **Critical:** Replace the editor with TipTap + a markdown serializer. It is currently deleting customers' pasted tables.
- **Critical:** Short-lived JWTs + refresh + `token_version` revocation; stream tickets instead of tokens in URLs.
- **High:** Redis → distributed rate limiting, SSE pub/sub, then a real job queue (`arq`/RQ). Media to S3/R2. Then raise `WEB_CONCURRENCY`.
- **High:** Anthropic prompt caching on the research digest and system prompts. 40–70% input-cost reduction.
- **High:** Complete cost metering across all ~45 calls; enforce the per-article ceiling that currently only displays.
- **High:** Prompt-injection defences on fetched excerpts.
- **High:** Google Search Console integration — free, and it converts your fake analytics into real ones.
- **High:** Extract the score constants duplicated across four files; route every JSON call site through your existing robust parser.
- **Medium:** Sentry, structured logs with request IDs, admin audit log.
- **Medium:** Type and spacing scales; one run surface instead of four; loading skeletons; fix the empty-state-during-load bugs.
- **Medium:** Rewrite the docs. They currently assert the absence of auth, ownership, rate limiting and the Run entity — all of which exist.

### 6 months — build the moat

- **Critical:** **Sites as a first-class primitive** — the retention layer. Site → content inventory → topic map → internal link graph → refresh queue.
- **Critical:** Wire the memory engine into the pipeline and give it embeddings. Internal linking and duplicate detection stop being dead code.
- **High:** Semantic SEO layer — TF-IDF term targets from the corpus you already fetch. This is Surfer's core feature and you are one function from a credible version.
- **High:** The heading-gap diff. Pure computation on data already in memory.
- **High:** Golden-set eval harness, in the repo this time, running in CI.
- **High:** Bulk CSV runs and team roles — the agency persona your PRD names first and currently cannot serve.
- **Medium:** Plagiarism/near-duplicate check against the fetched corpus. Author entity + E-E-A-T schema. Webflow, Ghost, Shopify connectors. Public API.

### 1 year — the defensible product

- Publish → measure → refresh as a closed loop, automatically queueing rewrites when GSC shows decay. **This is the retention engine.**
- Per-customer brand voice models trained on their existing published content.
- Site-wide topical authority planning: "write these 14 articles in this order to own this cluster."
- Claim-level provenance UI — hover any statistic, see the source sentence from the page it came from. Nobody in this category has it.
- Enterprise readiness: SSO, immutable audit log, DPA, SOC 2 path, regional data residency.
- An accumulated evidence corpus across all runs — the one asset that compounds and cannot be copied.

---

## 17 · Scorecard & Engineering Process

The scorecard is in [§00](#scorecard). Two process findings belong here because they explain how the defects above survived.

#### 🟠 HIGH — Test isolation is accidental, and your suite is currently red

Only 5 of 26 test files force the mock adapter. The other 21 rely on the environment having no API keys. But `backend/.env` exists with live OpenAI, Anthropic, Google, xAI, Brave and Ahrefs keys and `RESEARCH_PROVIDER=hybrid`.

**I ran the suite: 222 passed, 3 failed, 4m32s — and it made live HTTP requests to DuckDuckGo, tomsguide.com, wired.com and goodhousekeeping.com.** One failure is precisely this:

```
assert done["data"]["research"]["pages_analyzed"] == 0  # mock => no fetches
E       assert 4 == 0
```

CI passes only because GitHub Actions has no secrets configured. **Your tests cost money and give different answers on different machines.**

**Fix:** An autouse fixture that scrubs provider env vars and forces the mock adapter suite-wide, plus `pytest-socket` to make network access an error rather than a surprise. Half a day, and it makes every future test result mean something.

> 3 failures: `test_outline.py` ×2, `test_pipeline_redesign.py:273`

#### 🟠 HIGH — Docs actively assert the opposite of what the code does

- `ARCHITECTURE.md` says "there is **no durable Run entity**" → `models.py:165` defines `class Run`
- `ARCHITECTURE.md` says "**no identity, users, sessions, roles, or ownership exists**; login/signup pages are cosmetic" → `security.py` has the full JWT stack, `models.py:105` has `owner_id`
- `ARCHITECTURE.md` and `DEPLOYMENT.md` both say "**no rate limiting** — add a limiter (e.g. slowapi)" → `app/ratelimit.py` exists with tests
- `README.md` still says "Status: M0 — Foundation… a React dashboard shell"

Docs froze on 18 Jul; code continued through 25 Jul across seven commits. For a solo project this is a nuisance; the moment a second engineer or a security reviewer reads them it is actively dangerous.

### Also

- **No linting anywhere** — the frontend's `lint` script is dead (eslint isn't even installed), and CI never invokes it
- No coverage, no type checking on Python
- No lockfile, with `>=`-only requirements
- A **three-way interpreter split** — the dev machine runs Python 3.14, CI and prod pin 3.12, and your own deployment doc warns that 3.14 silently drops the Postgres driver
- **Zero frontend tests, zero E2E tests**
- The durability guarantee you sell hardest (detached runs, the reaper, `Last-Event-ID` replay) has **no test at all**
- Deploy is manual, single-environment, with migrations inside the start command, no staging, no rollback procedure, and **no database backups** on a free-tier Postgres

### ✅ What's genuinely excellent, specifically

The commenting is the best I've seen in a codebase this age — roughly 40 comments explain _why_, several referencing the specific bug that motivated them.

The evidence engine's core primitive (drop any fact whose source wasn't actually fetched) is exactly right. The mock provider deliberately returns **zero** sources rather than plausible fake URLs, with the regression documented inline — choosing an empty result over a convincing fake is an instinct most engineers don't have.

Auto depth targeting sizes the article at 85% of the median _fetched competitor_ word count, clamped so one outlier can't triple your cost, then propagates per-section budgets computed in Python "because an LLM never does the division itself."

The autofix pass splits code fences so `--amend` survives the em-dash rule. The fact-checker's false-positive suppression — model numbers, scope prices, advice openers, the article's own keyword phrases — is a list of scars from real bugs.

None of this is the work of someone who doesn't know what they're doing. **That is why the gaps are worth naming precisely.**

---

## A · Top 25 Critical Improvements

|   # | Improvement                                            | Severity     | Implementation                                                                    |
| --: | ------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------- |
|   1 | Scope portfolio analytics to the owner                 | **Critical** | `select(Project).where(Project.owner_id == user.id)` at `analytics/service.py:94` |
|   2 | Encrypt WordPress + webhook credentials at rest        | **Critical** | Fernet from `CREDENTIAL_KEY`; migration re-encrypts rows                          |
|   3 | Close the inline-citation escape hatch                 | **Critical** | Match cited name against real fetched sources; `factcheck/service.py:573`         |
|   4 | Add `require_project_access` to the 5 orphaned routers | **Critical** | export, media, analytics, memory ×2 — copy the working pattern                    |
|   5 | Ship Stripe Checkout + webhook                         | **Critical** | Wire into existing `credits.set_plan`; flip `PAYMENTS_ENABLED`                    |
|   6 | Delete the fake reCAPTCHA claim                        | **Critical** | One line: `AuthShell.tsx:171`                                                     |
|   7 | Refund credits on run failure                          | **Critical** | 3 call sites; ledger already has the reason enum                                  |
|   8 | Prompt-injection defences on fetched excerpts          | **Critical** | Escape delimiters, fence untrusted blocks, validate domain vs URL                 |
|   9 | Replace the editor with TipTap                         | **Critical** | Stops silent data loss on paste; markdown serializer keeps storage format         |
|  10 | Emit the no-evidence guard when evidence is empty      | High         | Invert the condition at `article/service.py:441`                                  |
|  11 | Default `research_provider` to DuckDuckGo              | High         | One line; activates every anti-hallucination mechanism                            |
|  12 | Free trial on real providers                           | High         | 3 articles on your keys; delete mock-provider marketing                           |
|  13 | Global `:focus-visible` ring                           | High         | ~10 lines; remove `outline:none` from `.rt-editor`                                |
|  14 | SSRF guard + no redirects on the competitor fetcher    | High         | Call the guard you already wrote; `fetcher.py:152`                                |
|  15 | Short-lived JWTs + refresh + `token_version`           | High         | Also check `is_active` in the SSE path; stream tickets in URLs                    |
|  16 | Anthropic prompt caching                               | High         | `cache_control` on the research digest + system prompts; 40–70% input savings     |
|  17 | Complete cost metering + enforce the ceiling           | High         | Currently ~10% of spend is counted; caps are display-only                         |
|  18 | Report the provider that actually ran                  | High         | Yield `adapter.provider`; warn on substitution; badge it in the UI                |
|  19 | Route all JSON parsing through the robust parser       | High         | 8 call sites; the function already exists in your repo                            |
|  20 | Redis → job queue → S3 media → multi-worker            | High         | Sequenced; unblocks scaling past one concurrent run                               |
|  21 | Hermetic tests                                         | High         | Autouse env scrub + forced mock + `pytest-socket`; fix the 3 red tests            |
|  22 | Trust `X-Forwarded-For` only from known proxies        | Med          | Fixes the brute-force bypass; also move CORS outside the limiter                  |
|  23 | Admin audit log + Sentry + request IDs                 | Med          | Promote/suspend/delete currently leave zero trace                                 |
|  24 | Fix AEO and Originality scoring                        | Med          | Both are structurally incapable of failing; score before autofix                  |
|  25 | Rewrite the docs; extract duplicated score constants   | Med          | Docs assert the opposite of reality; `TARGETS` exists in 4 places                 |

---

## B · Ten Differentiators Worth Building

> ### 🎯 The competitive advantage nobody is exploiting — including you
>
> You already fetch the pages that currently rank, mine facts from them, and keep a whitelist that drops any fact whose source wasn't actually retrieved. **That is provenance infrastructure, and no SEO tool in this market has it.**
>
> Surfer tells you which words to use. Clearscope tells you which terms to cover. Nobody tells you _where every number in this article came from, and lets you click it._
>
> Fix the citation loophole, surface the evidence bank in the article UI, and export a claim-level provenance report alongside the draft — and you have the only AI writer an enterprise legal team would approve. **That is worth more than the council, and it is 80% built.**

1. **Claim-level provenance.** Hover any statistic in the draft, see the exact source sentence from the exact page it was mined from. Export it as a verification report. Category-defining, and mostly already in your database.
2. **A publish gate that actually blocks.** Everyone ships advisory scores. You ship a deterministic gate with a reason. Make refusing to publish the headline feature — "the only AI writer that will tell you no."
3. **Visible multi-model disagreement.** The debate transcript as a user-facing artifact: here is where four models disagreed about your content and how it was resolved. Genuinely novel — once it is honestly four models.
4. **Restricted-niche routing.** Underexploited. Jasper, Surfer and Clearscope will not serve these verticals. There is a real, underserved, high-willingness-to-pay market with almost no competition.
5. **Publish → measure → refresh, closed.** GSC detects decay, the system queues a rewrite using the original evidence bank, and republishes. Converts a transactional tool into a subscription nobody cancels.
6. **Evidence-anchored refresh.** Because you keep the corpus, a refresh knows what changed since the original: new competitors, new facts, stale figures. Nobody can do this without your archive.
7. **Cost transparency per article.** Show real spend per run, per model, per stage. In a market where every competitor hides token costs behind credits, radical honesty is positioning.
8. **Brand voice from published content.** Point at a customer's existing site, learn the voice, enforce it as house rules. Your compliance engine is the skeleton.
9. **The golden-set eval harness, shipped as a feature.** Let customers define their own quality bar and score against it. Turns your internal test into a retention mechanism — and gets it back into version control where it belongs.
10. **Agency multi-site cockpit.** 40 sites, one queue, per-site voice and rules, per-client reporting. Your PRD names this persona first and the product currently cannot serve them at all.

---

## C · Can It Compete?

> **Against Surfer, Clearscope, Frase and MarketMuse: not today, plausibly within a year, and only by refusing to fight them on their own ground. Against Ahrefs and Semrush: no, and you shouldn't try — they are your suppliers, not your rivals.**

### Why not today

Three reasons, none of which are about AI quality.

1. **You cannot take money** — that alone ends the conversation.
2. **You would fail any enterprise security review** on cross-tenant reads and plaintext credentials in the first fifteen minutes.
3. **Your fact-check gate — the entire product thesis — is passable by prefixing a fabricated statistic with "according to."**

Beneath that: no semantic term engine (Surfer's core), no topic model (MarketMuse's core), no rank tracking, no team roles, one CMS integration, and a free tier that demonstrates the product not working.

### Why plausibly within a year

Because the hard part is built and the missing parts are known. The pipeline architecture — durable runs, streaming, evidence mining, deterministic scoring, a real gate — is more sophisticated than what Frase ships and it took one person two weeks. The security defects are consistency failures with a correct pattern already in the codebase. Payments are a day. The semantic layer is TF-IDF over a corpus you already download. The heading-gap diff is pure computation on data already in memory.

And the strategic position is genuinely sound: Surfer and Clearscope optimise drafts you wrote, so they need a writer. You produce publishable content end to end with a refusal mechanism. As Google keeps tightening on unhelpful AI content, "the tool that blocks the article" ages better than "the tool that scores it 87."

### Why you must not fight them head-on

Surfer and Ahrefs have index-scale data, years of brand, and sales teams. Rebuilding their term engine or their crawl is a losing race. The winnable position is the one they structurally cannot occupy:

> **Verifiable, provenance-backed content generation for high-volume operators in niches the incumbents refuse to serve, with a gate that blocks rather than advises.**

That is a real wedge and you are most of the way to it.

### The honest bottom line

This is a strong engine with an unshippable trust layer, wrapped in marketing that overstates what it does and priced below the cost of the problem it solves.

There is roughly **six weeks of unglamorous work** — security boundaries, payments, the citation fix, one editor swap — between "impressive prototype" and "a product you can charge $149/month for without lying." Do that work before adding a single feature.

The instinct that produced the evidence engine, the deterministic gate, and the mock provider that returns nothing rather than something fake is the right instinct. It just hasn't been applied evenly, and evenness is what separates the two categories.

---

_Audit performed 28 Jul 2026 against commit `e02c035` · 16,645 backend LOC · 16,438 frontend LOC · 226 backend tests (222 passed, 3 failed, 1 skipped, 4m32s, live network) · 0 frontend tests · 0 E2E tests_
