# Editor Roles

> **Status:** v1.0 — complete. Phase 17. **Canonical role registry.**
> **Sixteen editors. Eighteen categories. Every category has exactly one owner.** No concern is reviewed by two editors, and none is reviewed by nobody.

## Overview

**Purpose.** Define the sixteen editorial roles, the category each owns, what each evaluates, and the hierarchy that orders them.

**Scope.** Roles and ownership. The Issue schema is `issue-model.md`; how ownership feeds the decision is `consensus-engine.md`.

**No provider, model, or family is named in this document or in the code that implements it.** An editor is a responsibility; which model serves it is runtime policy (`provider-mapping.md`).

## Exclusive ownership

**Every issue category has exactly one owning editor.** That single property does most of the architectural work:

| Without exclusive ownership | With it |
|---|---|
| Two editors raise the same defect twice | One Issue, one owner |
| A concern nobody owns goes unreviewed | Coverage is provable |
| Duplicate Issues need merging | **Merging is never required** |
| Debate is about who is right | Debate is about whether the finding holds |

**Issues are never merged automatically**, and exclusive ownership is what makes that safe — two Issues in one category came from one editor and are genuinely distinct findings.

**An editor that raises an Issue outside its category has it discarded and recorded.** The Issue is not reassigned to the correct owner: reassignment would mean EIE deciding what an editor meant, and a drifting editor is a routing or prompt defect worth surfacing (`editorial-workflow.md`).

## The sixteen editors

| # | Editor | Owns category | Evaluates |
|---|---|---|---|
| 1 | **Safety Editor** | `safety` | Harmful, dangerous, or prohibited content |
| 2 | **Compliance Editor** | `compliance` | Regulatory, legal, and disclosure obligations |
| 3 | **Bias Editor** | `bias` | Unfair representation, loaded framing, unbalanced treatment |
| 4 | **Fact Editor** | `facts` | Factual accuracy of stated claims |
| 5 | **Evidence Editor** | `evidence` | Whether claims resolve to Evidence Bank content |
| 6 | **Research Editor** | `entities` | Entity identity, attribution, and verification |
| 7 | **Logic Editor** | `logic` | Argument validity, contradiction, non-sequitur |
| 8 | **Freshness Editor** | `freshness` | Currency of claims, statistics, and sources |
| 9 | **SEO Editor** | `seo` · `duplicate_content` | Search-visibility quality and originality |
| 10 | **Structure Editor** | `structure` | Heading hierarchy, section order, outline fidelity |
| 11 | **Internal Linking Editor** | `internal_links` · `external_links` | Link integrity in both directions |
| 12 | **Metadata Editor** | `metadata` | Title, description, schema, canonical intent |
| 13 | **Accessibility Editor** | `accessibility` | Alt text, link text, structural accessibility |
| 14 | **Readability Editor** | `readability` | Sentence and paragraph complexity, clarity |
| 15 | **Brand Editor** | `brand` | Voice, terminology, positioning |
| 16 | **Reader Experience Editor** | `tone` | How the piece lands with its intended reader |

**Two editors own two categories each**, and both pairings are one concern under two labels:

**SEO Editor owns `seo` and `duplicate_content`** because originality is a search-visibility property and nothing else on the board evaluates it. Splitting it would create an editor with one narrow category and a permanent overlap dispute with SEO.

**Internal Linking Editor owns `internal_links` and `external_links`** because link integrity applies identically in both directions — does the target exist, is the anchor honest, is the link warranted. The role name reflects its primary concern; its ownership is link integrity.

**Every other editor owns exactly one category.**

## Role definitions

### 1 · Safety Editor — `safety`

**Evaluates** content that could cause harm: dangerous instructions, prohibited categories, unsafe advice in regulated domains.

**Raises** `CRITICAL` for content that must not publish; `HIGH` for content requiring qualification.

**Never** evaluates tone, legality, or fairness — those are Reader Experience, Compliance, and Bias.

**Highest hierarchy rank.** A Safety Issue at `CRITICAL` blocks regardless of every other finding, and a failed Safety Editor forces `HUMAN_REVIEW_REQUIRED` rather than proceeding (`architecture.md`).

**Distinct from platform guardrails.** `08-ai-platform/guardrails.md` blocks unsafe *generation* at the model boundary; the Safety Editor reviews content that passed generation. A guardrail block is terminal and never reaches this editor.

### 2 · Compliance Editor — `compliance`

**Evaluates** regulatory and legal obligations: required disclosures, prohibited claims in regulated verticals, attribution requirements, jurisdictional constraints declared in the brief.

**Never** interprets law. It checks stated obligations against content and raises Issues; legal judgement is a human decision reached through `HUMAN_REVIEW_REQUIRED`.

**Second rank.** A failed Compliance Editor also forces `HUMAN_REVIEW_REQUIRED`.

### 3 · Bias Editor — `bias`

**Evaluates** representational fairness: loaded framing, unbalanced treatment of contested topics, unwarranted generalisation, exclusionary language.

**Never** evaluates factual accuracy or tone. A claim that is unfair *and* wrong produces two Issues from two editors.

**Distinguishes editorial stance from bias.** A deliberate point of view declared in the brief is not an Issue; unacknowledged one-sidedness on a contested question is.

### 4 · Fact Editor — `facts`

**Evaluates** whether stated claims are true.

**Never** evaluates whether a claim is *supported* — that is the Evidence Editor. A true claim with no citation produces an Evidence Issue, not a Fact Issue. A false claim with a citation produces a Fact Issue, and usually an Evidence Issue too.

**The Fact/Evidence split is the board's most important boundary.** Collapsing them produces the failure the grounding invariant exists to prevent: content that is cited and wrong, or right and unsupported, being treated identically.

### 5 · Evidence Editor — `evidence`

**Evaluates** the grounding chain: does each claim resolve to Evidence Bank content through the Citation Engine, is the evidence adequate, does it actually support the claim.

**Owns the platform's grounding invariant at review time** (ADR-009). An unsupported claim is an Evidence Issue whose severity rises with the claim's load-bearing weight.

**Reads `supported: false` citations directly.** The platform already marks them, and this editor's job is to judge whether the gap matters (`06-api/content-api.md`).

**Never** judges whether evidence is *current* — that is Freshness.

### 6 · Research Editor — `entities`

**Evaluates** entity identity and attribution: is the named entity the right one, is the attribution correct, does an alias resolve, is a statistic attributed to its actual source.

**The most common escalator.** Entity verification frequently requires evidence the run does not have, and this editor issues the majority of research escalations (`editorial-workflow.md`).

**Never** merges entities or writes to the Knowledge Platform. Merging is a human decision requiring a note, and authoritative entities are never merged automatically (`11-knowledge-platform/deduplication.md`).

### 7 · Logic Editor — `logic`

**Evaluates** argument structure: internal contradiction, non-sequitur, unsupported inference, circular reasoning, conclusions exceeding their premises.

**Never** evaluates whether premises are true — that is Fact. An article can be perfectly logical and entirely false, and that produces Logic-clean, Fact-critical.

### 8 · Freshness Editor — `freshness`

**Evaluates** currency: stale statistics, superseded guidance, time-sensitive claims without a date, evidence past its useful life.

**Consumes the Knowledge Platform's freshness assessment** rather than computing one, including the `unknown` category — a source with no discoverable date is not stale, and treating it as such would misrepresent an absence of information (`11-knowledge-platform/freshness-engine.md`).

**Weights by citation load.** Stale evidence supporting a load-bearing claim outranks stale evidence in an aside.

### 9 · SEO Editor — `seo` · `duplicate_content`

**Evaluates** search-visibility quality: keyword usage and over-usage, intent alignment, competitive coverage gaps, and originality against the corpus.

**Consumes SEO Engine scores** where they exist rather than recomputing them. ADR-021 assigns those categories a single producer, and this editor produces Issues, not Scores (`README.md`).

**Runs before structural optimization.** EIE occupies the Review stage, so the SEO Editor evaluates the draft as written — the SEO Engine's structural changes come after and are re-validated by `FastRecheck` (ADR-011).

### 10 · Structure Editor — `structure`

**Evaluates** heading hierarchy, section order and balance, and **fidelity to the approved outline** — which is why the outline is in every editor's context.

**A structural deviation from the approved outline is an Issue**, because the outline was a human decision (`06-api/content-api.md`).

**Never** evaluates heading text quality — that is Metadata and Readability.

### 11 · Internal Linking Editor — `internal_links` · `external_links`

**Evaluates** link integrity: does the target exist, is the anchor honest about the destination, is the link warranted, is there over- or under-linking.

**Never** fetches an external URL directly. Link reachability comes through the platform's existing fetch path with its SSRF controls (`16-security/api-security.md`).

### 12 · Metadata Editor — `metadata`

**Evaluates** title, meta description, structured-data intent, and canonical signals — against the brief and the approved outline.

**Never** evaluates on-page headings — that is Structure.

### 13 · Accessibility Editor — `accessibility`

**Evaluates** content accessibility: alt text presence and quality, link text that makes sense out of context, heading structure as a navigation aid, colour-independent meaning in described visuals.

**Distinct from the application's accessibility gate.** `15-application-ui/accessibility.md` governs the product's interface; this editor governs the *content* the product produces.

### 14 · Readability Editor — `readability`

**Evaluates** clarity: sentence and paragraph complexity, jargon density against the declared audience, passive construction where it obscures.

**Reads the brief's audience declaration.** Technical density appropriate for a specialist audience is not an Issue.

**Never** evaluates voice or tone — those are Brand and Reader Experience.

### 15 · Brand Editor — `brand`

**Evaluates** voice consistency, terminology adherence, and positioning against the workspace's declared brand context.

**Never** evaluates emotional register — that is Reader Experience. Brand asks *does this sound like us*; Reader Experience asks *does this land*.

### 16 · Reader Experience Editor — `tone`

**Evaluates** how the piece lands for its intended reader: does it answer the question the reader arrived with, is the register appropriate, does it respect the reader's time and expertise.

**The only editor evaluating the piece as a whole experience** rather than a property of it. Its findings are frequently the lowest severity and the highest value.

## Editorial hierarchy

**Priority orders which concerns dominate when the board disagrees. Lower ranks never override higher ranks.**

| Rank | Category | Owner |
|---|---|---|
| 1 | `safety` | Safety Editor |
| 2 | `compliance` | Compliance Editor |
| **3** | **`bias`** | Bias Editor |
| 4 | `facts` | Fact Editor |
| 5 | `evidence` | Evidence Editor |
| **6** | **`entities`** | Research Editor |
| 7 | `logic` | Logic Editor |
| 8 | `freshness` | Freshness Editor |
| 9 | `seo` | SEO Editor |
| **10** | **`duplicate_content`** | SEO Editor |
| 11 | `structure` | Structure Editor |
| **12** | **`internal_links`** | Internal Linking Editor |
| **13** | **`external_links`** | Internal Linking Editor |
| 14 | `metadata` | Metadata Editor |
| 15 | `accessibility` | Accessibility Editor |
| 16 | `readability` | Readability Editor |
| 17 | `brand` | Brand Editor |
| 18 | `tone` | Reader Experience Editor |

**The briefed hierarchy specified thirteen concerns; eighteen categories exist.** The five bolded ranks are a derived placement, inserted by nearest concern **without reordering any briefed pair**. Every relation the brief stated holds: safety < compliance < facts < evidence < logic < freshness < seo < structure < metadata < accessibility < readability < brand < tone.

**The insertions and their reasoning:**

| Inserted | Placed | Because |
|---|---|---|
| `bias` | After compliance | Representational integrity is adjacent to legal obligation, and both precede accuracy |
| `entities` | After evidence | Entity identity is a factual property, resolved by evidence |
| `duplicate_content` | After seo | Same editor, same concern class |
| `internal_links` · `external_links` | After structure | Navigation is structural |

**This placement is recorded as derived rather than presented as briefed**, so it can be corrected without archaeology.

## How hierarchy is used

**Hierarchy does not silence lower-ranked editors.** Every editor reviews, every Issue is recorded, and every Issue appears in the report.

**Hierarchy decides three things:**

| Use | Rule |
|---|---|
| **Consensus dominance** | A `CRITICAL` at rank 1–5 blocks regardless of lower-rank findings |
| **Debate resolution** | Where two Issues conflict, the higher rank prevails |
| **Task ordering** | The Revision Planner orders tasks by rank, then severity |

**A `CRITICAL` readability Issue does not outrank a `HIGH` safety Issue.** Severity orders within a rank; rank orders across.

**A high-ranked editor cannot manufacture authority by inflating severity.** Severity is challengeable in debate, and an unevidenced severity claim is exactly what a challenge targets (`debate-engine.md`).

## Editor context

**Each editor receives a context assembled for its role by the Context Builder** — never a prompt EIE constructed.

| Every editor receives | Only some receive |
|---|---|
| The draft or its changed sections | Evidence and citations — Fact, Evidence, Research, Freshness |
| The brief and approved outline | Existing scores — SEO, Readability |
| Issue history from prior rounds | Brand context — Brand, Reader Experience |
| Its own category definition | Compliance context — Compliance, Safety |

**No editor receives the full evidence corpus.** Context is bounded per role, which is what keeps sixteen reviews affordable (`architecture.md`).

**No editor receives provider information, routing decisions, or another editor's model identity** (`06-api/ai-api.md`).

## Adding an editor

**A seventeenth editor requires a new category with no existing owner.** If the concern is already owned, the answer is a better prompt for the existing editor, not a second reviewer.

| Required | Detail |
|---|---|
| A new category | Not owned by any existing editor |
| A hierarchy rank | Placed relative to existing ranks, with reasoning |
| A registry entry | Source-controlled, like every role definition |
| Cost justification | The board's cost is linear in its size |

**Adding a category is additive under ADR-021's evolution rules**; adding a *second owner* for an existing category is not, and is refused.

## Business rules

1. **Sixteen editors; eighteen categories; every category has exactly one owner.**
2. **Two editors own two categories each**, and both pairings are one concern.
3. **An Issue outside the editor's category is discarded and recorded**, never reassigned.
4. **Issues are never merged automatically.**
5. **Fact and Evidence are separate concerns**, and collapsing them is prohibited.
6. **The Evidence Editor owns the grounding invariant at review time.**
7. **The Freshness Editor consumes the platform's assessment**, including `unknown`.
8. **The SEO Editor consumes SEO Engine scores** and produces Issues, not Scores.
9. **The Structure Editor treats outline deviation as an Issue.**
10. **No editor fetches an external URL directly.**
11. **The Research Editor never writes to the Knowledge Platform.**
12. **Hierarchy orders across categories; severity orders within one.**
13. **Hierarchy never silences a lower-ranked editor**; every Issue is recorded.
14. **The five derived hierarchy placements are marked as derived.**
15. **Context is bounded per role**; no editor receives the full corpus.
16. **No editor receives provider or model information.**
17. **A seventeenth editor requires an unowned category**; a second owner is refused.
18. **A failed Safety or Compliance editor forces `HUMAN_REVIEW_REQUIRED`.**

## Cross references

- `issue-model.md` — the schema every editor returns
- `consensus-engine.md` — how hierarchy and severity combine
- `debate-engine.md` — challenging severity and evidence
- `revision-planner.md` — task ordering by rank
- `provider-mapping.md` — role-to-provider assignment as policy
- `08-ai-platform/context-builder.md` — per-role context assembly
- `08-ai-platform/guardrails.md` — generation-time safety, distinct from the Safety Editor
- `11-knowledge-platform/freshness-engine.md` · `deduplication.md`
- `05-content-platform/seo-engine.md` · `review-engine.md`
- `01-system-architecture/13-adr-log.md` — ADR-009, ADR-011, ADR-021
