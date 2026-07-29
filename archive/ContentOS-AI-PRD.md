# ContentOS AI — Product Requirements Document

A multi-model AI content engine. OpenAI, Claude, Gemini and Grok debate, a Judge agent decides, and content is scored for Google, AI Overviews, ChatGPT and Perplexity before it publishes.

| Field | Detail |
| --- | --- |
| Product | ContentOS AI |
| Owner | Amit Biwaal — Tech Savy Crew |
| Document | Product Requirements Document (PRD) |
| Version | 1.0 |
| Status | Draft for build |
| Date | June 2026 |

---

## 1. Executive summary

ContentOS AI is a content production platform that runs a single brief through multiple large language models at once. Each model is given a specialist role, the models challenge each other in a structured debate, and a Judge model accepts, rejects or merges every recommendation. The output is a fact-checked article graded on four search surfaces and held behind an eight-score publish gate.

**Why it exists.** Every AI tool returns different advice and writes in a recognisable single-model voice, with no way to tell which suggestion is correct. ContentOS turns that disagreement into the product: the models argue, conflicts surface, and a judge resolves them with reasons a human can read and override.

**Who it is for.** High-volume, multi-site content operations, including adult and other restricted niches where mainstream tools refuse or dilute output.

## 2. Problem statement

- **Single-AI bias.** One model produces one perspective and one detectable writing pattern.
- **Conflicting guidance.** ChatGPT, Gemini, Claude and Grok each recommend different structures and keywords; operators cannot tell which is right.
- **Fragmented optimisation.** SEO, answer-engine and AI-engine optimisation are handled in separate tools and rarely reconciled.
- **Unverified claims.** AI text invents facts; at scale this is a ranking and trust risk, sharply higher in restricted niches.
- **Restricted-niche refusals.** Mainstream models refuse adult-adjacent topics, blocking the exact verticals this operation serves.

## 3. Goals and success metrics

| Goal | Metric | Target |
| --- | --- | --- |
| Remove single-AI bias | Articles produced via multi-agent debate | 100% of articles |
| Unified search optimisation | Avg SEO + AEO + GEO + HEO score | ≥ 88 |
| Trustworthy output | Avg Fact Score on published pieces | > 85 |
| Faster production | Brief to publish-ready draft | < 30 minutes |
| Lower cost per piece | Blended AI cost per article | Tracked, trending down |
| Scale | Articles per editor per week | 3x manual baseline |

## 4. Non-goals (out of scope for v1)

- On-platform image generation; images are placeholders, sourced later from an external pipeline.
- Autonomous publishing without human approval; a human always approves before publish in v1.
- Full rank-tracking suite; analytics is read-only and lightweight until the generation workflow is stable.
- Social media scheduling and distribution.

## 5. Target users and personas

| Persona | Needs | How ContentOS helps |
| --- | --- | --- |
| Agency owner / operator | Volume across many sites without quality loss | Multi-site projects, council debate, publish gate |
| SEO content editor | Control the final draft, fix issues fast | 3-panel editor, live scores, ranked fixes |
| Niche publisher | Content where mainstream tools refuse | Restricted-niche provider routing, house rules |
| Reviewer / approver | Confidence a piece is safe to publish | Fact checker, decision log, publish gate |

## 6. User stories

- **As an operator,** I want to start a project with just a topic and keyword so that research and a draft begin without manual setup.
- **As an operator,** I want four AI models to debate the brief so that I get a reconciled strategy instead of one model's opinion.
- **As an editor,** I want to see why a recommendation was accepted or rejected so that I can trust or override the decision.
- **As an editor,** I want live SEO, AEO, GEO and HEO scores while editing so that I know what to fix before publishing.
- **As a reviewer,** I want every factual claim graded by source and risk so that no unsupported claim goes live.
- **As an operator,** I want to swap which model fills each role so that I can route restricted topics to a permissive provider.
- **As an operator,** I want one-click export to WordPress so that the publish step is not manual copy-paste.

## 7. Product overview and architecture

ContentOS is organised as a pipeline. A brief enters, research is gathered, a council of role-based agents debates it, a judge resolves conflicts, an outline and draft are produced, the draft is scored and fact-checked, and on passing the gate it is exported and stored in memory.

**Pipeline:** Project → Research Intelligence → Council Round 1 (reports) → Round 2 (debate) → Round 3 (judge) → Outline → Article → Optimise + Fact-check → Schema + Export → Library + Memory.

### Architecture layers

| Layer | Responsibility |
| --- | --- |
| Frontend | React dashboard, white workspace with navy navigation, Linear / Ahrefs style |
| Backend | FastAPI orchestration, Celery for background and bulk jobs, run queue |
| AI layer | Provider adapter mapping each agent role to a swappable model; never hardcoded |
| Research | SERP / keyword provider, PAA, entity extraction, citation-source collection |
| Data | Projects, research, agent runs, outlines, drafts, scores, claims, links, memory |
| Export | WordPress REST, Google Docs, Markdown, HTML, DOCX, JSON-LD |

## 8. AI Council specification

### 8.1 Agent roles

| Agent | Default model | Responsibility |
| --- | --- | --- |
| Content Strategist | OpenAI | Brief and outline logic: intent, section order, priority |
| Human Editor | Claude | Natural tone, balance, no over-promising or unsupported superlatives |
| Search Intelligence | Gemini | Entities, answer blocks, FAQ design, citation readiness (AEO + GEO) |
| Trend Analyst | Grok | Fresh angles and real questions or complaints from social and Reddit |
| Judge Agent | OpenAI / Claude | Final decision on every recommendation, with reasons |

### 8.2 Orchestration and debate protocol

- **Round 1 — Reports.** All non-judge agents receive identical research and run in parallel. Each returns 3 to 6 specific recommendations for its own axis plus a confidence score.
- **Round 2 — Debate.** Each agent reads the others and challenges them. At least one real conflict must be surfaced, not hidden. Messages are tagged proposes, conflict or agree.
- **Round 3 — Judge.** The Judge rules on each major recommendation and outputs a final strategy. Output is strict JSON consumed by the outline builder.

### 8.3 Judge decision labels

| Label | Meaning |
| --- | --- |
| Accepted | Sourced and on-strategy; included as-is |
| Rejected | Unsupported, risky or off-intent; removed |
| Needs Evidence | Useful but requires a citation before use |
| Merge | Combined with another recommendation |
| Manual Review | Escalated to a human editor |

## 9. Functional requirements

Requirements are grouped by module. Priority uses MoSCoW: Must, Should, Could.

### 9.1 Dashboard

Portfolio-level health across all projects.

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1.1 | Show total projects, articles generated, average SEO score and AI search score | Must |
| FR-1.2 | Show helpful-content score, publish-ready count, traffic opportunity and decay alerts | Must |
| FR-1.3 | List recent drafts with project, publish score and pipeline status | Must |
| FR-1.4 | Surface Google and AI-search update alerts requiring action | Should |

### 9.2 Projects

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-2.1 | List every project with live SEO / AEO / GEO / HEO and publish scores | Must |
| FR-2.2 | Show pipeline stage (research, council, editor, ready, published) | Must |
| FR-2.3 | Filter and search by website, type and status | Should |

### 9.3 New Content Project

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-3.1 | Capture website, topic, primary keyword, country, audience, tone and goal | Must |
| FR-3.2 | Let the user select which models join the council | Must |
| FR-3.3 | Load the website's house rules and topical memory automatically | Must |
| FR-3.4 | Trigger Research Intelligence on submit | Must |

### 9.4 Research Intelligence

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-4.1 | Collect top SERP results, competitor H2 headings and People Also Ask | Must |
| FR-4.2 | Extract entities and trusted citation sources for the topic | Must |
| FR-4.3 | Pull social / Reddit signals for gaps and real questions | Should |
| FR-4.4 | Detect search intent and keyword difficulty / volume | Must |
| FR-4.5 | Normalise all research into a single brief the council consumes | Must |

### 9.5 AI Debate Room

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-5.1 | Run all council agents in parallel and show each report with confidence | Must |
| FR-5.2 | Render the cross-critique thread with surfaced conflicts | Must |
| FR-5.3 | Show the Judge decision for each recommendation with a reason | Must |
| FR-5.4 | Persist the full debate and decisions for audit | Should |
| FR-5.5 | Allow re-running the council and human override of any decision | Should |

### 9.6 Outline Builder

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-6.1 | Convert the approved strategy into H1 / H2 / H3 structure | Must |
| FR-6.2 | Mark table, FAQ, answer-block, image and CTA placements | Must |
| FR-6.3 | Attach schema hooks and run outline-level checks | Should |
| FR-6.4 | Allow drag reorder and manual edit of nodes | Should |

### 9.7 Article Writer

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-7.1 | Three-panel editor: section nav, editable draft, live score panel | Must |
| FR-7.2 | Generate the draft section by section from the outline | Must |
| FR-7.3 | Update SEO / AEO / GEO / HEO scores and issues live as text changes | Must |
| FR-7.4 | Show keyword coverage and missing keywords | Should |
| FR-7.5 | Regenerate a single section and show an old-versus-new diff | Should |

### 9.8 SEO / AEO / GEO / HEO Optimizer

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-8.1 | Display all eight scores for the current article | Must |
| FR-8.2 | List the single highest-impact fix per axis, ranked by score gain | Must |
| FR-8.3 | Apply a fix or send it back to the relevant agent | Should |

### 9.9 Fact Checker

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-9.1 | Extract every factual or statistical claim from the draft | Must |
| FR-9.2 | Attach a source, confidence score and risk level to each claim | Must |
| FR-9.3 | Assign a decision label and block publish on unsupported high-risk claims | Must |

### 9.10 Schema and Export

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-10.1 | Generate JSON-LD appropriate to the content type | Must |
| FR-10.2 | Export to WordPress, Google Docs, Markdown, HTML and DOCX | Must |
| FR-10.3 | Enforce the publish gate before allowing export to a live site | Must |
| FR-10.4 | Treat FAQPage schema as parse-value only, not a SERP-feature claim | Should |

### 9.11 Content Memory

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-11.1 | Maintain a per-website knowledge graph of covered topics | Must |
| FR-11.2 | Suggest internal links with anchor text for the current draft | Must |
| FR-11.3 | Warn on duplicate or thin overlapping content and suggest merge / 301 | Should |
| FR-11.4 | Track topical authority coverage by cluster | Could |

### 9.12 Analytics

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-12.1 | Show organic traffic, top-10 keywords and AI citations | Should |
| FR-12.2 | Raise content-decay alerts when pages lose traffic | Should |
| FR-12.3 | Feed published performance back into the eval loop | Could |

### 9.13 Settings and Provider Adapter

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-13.1 | Map each agent role to a model the user can swap | Must |
| FR-13.2 | Store API keys encrypted per project | Must |
| FR-13.3 | Configure brand voice and house rules per website | Must |
| FR-13.4 | Route restricted-niche topics to permissive providers automatically | Must |
| FR-13.5 | Fall back to an alternate provider on refusal or error | Must |

## 10. Scoring system

Every article is graded on eight scores combined into a single Publish Score. Scores are computed by a scoring service that reads the draft, the research and the fact-check results.

| Score | Measures | Gate target |
| --- | --- | --- |
| SEO | Keyword / intent match, headings, internal links, entities | ≥ 85 |
| AEO | Answer blocks, FAQs, snippet-ready summaries | ≥ 85 |
| GEO | Entity clarity and citation readiness for AI engines | ≥ 80 |
| HEO | Human tone, usefulness, reading flow | ≥ 85 |
| EEAT | Experience, expertise, authority, trust signals | ≥ 80 |
| Fact | Claim accuracy and source reliability | > 80 |
| Spam Risk | Stuffing and unsupported-claim risk (lower is better) | < 25 |
| Publish | Combined gate score | ≥ 85 |

**Publishing gate.** An article is marked ready only when Publish ≥ 85, Fact > 80, and no high-risk unsupported claim remains. Anything below returns to the editor or the council.

**Originality (recommended addition).** A ninth score for plagiarism and AI-detection should be added before scaling; see Section 13.

## 11. Compliance and house-rules engine

House rules are enforced as a hard pass/fail step before export, separate from EEAT scoring. Rules are configurable per website.

- Ban em-dashes; replace with a comma or period.
- Source every negative or statistical claim to a named source with nofollow.
- Block testing / methodology claims such as tested-X-platforms or 200-plus-hours.
- Keep FAQ blocks and schema for AI parsing only; never claim FAQPage rich results (deprecated May 2026).
- Lock body typography to 16px / #334155; only headers, byline and table cells may differ.
- Enforce editorial voice (we, not I) and any platform-specific naming rules.

**Restricted-niche routing.** Adult-adjacent topics are routed automatically to permissive providers (for example Grok or Claude). Mainstream providers that refuse are bypassed and a fallback is used.

## 12. Provider adapter and failover

- Each agent role points at a provider via configuration; no model name is hardcoded in logic.
- A registry holds model id, context window, cost per token and content-policy tier per provider.
- On refusal, timeout or error, the adapter retries with backoff, then fails over to the next eligible provider for that role.
- Restricted topics are matched against a policy filter and only permissive-tier providers are eligible.

## 13. Cost and token budgeting

- Track per-run tokens and cost; aggregate to per-article and monthly totals.
- Enforce monthly budget caps and a per-article cost ceiling that triggers a model downgrade.
- Support cost-aware routing: cheaper models for research seats, premium for synthesis and compliance.
- Cache research results and reuse them across similar briefs to avoid repeat spend.

## 14. Data model

Core entities and their purpose. Relationships are one-to-many from project downward unless noted.

| Entity | Key fields | Purpose |
| --- | --- | --- |
| project | website, topic, keyword, country, audience, tone, goal | Root of a content job |
| research | serp, headings, paa, entities, sources, intent | Normalised brief input |
| agent_run | project_id, role, model, output, confidence, tokens, cost | One agent execution |
| debate | project_id, messages, conflicts | Round 2 transcript |
| decision | project_id, source, point, label, reason | Judge output, audit log |
| outline | project_id, nodes, elements, schema_hooks | Article skeleton |
| draft | project_id, sections, word_count, version | Article content + versions |
| score | draft_id, seo, aeo, geo, heo, eeat, fact, spam, publish | Quality grades |
| claim | draft_id, text, source, confidence, risk, label | Fact-check records |
| internal_link | draft_id, target_url, anchor | Link suggestions |
| memory | website, topic_node, cluster, coverage | Knowledge graph |
| usage | project_id, run_id, tokens, cost | Cost tracking |

## 15. Integrations

| Integration | Requirement |
| --- | --- |
| WordPress | Publish via REST as Gutenberg blocks with RankMath / Yoast field mapping and scheduling |
| Google Docs | Export formatted document for review |
| Markdown / HTML / DOCX | Export portable formats; HTML carries inline house-style typography |
| JSON-LD | Export schema independently of body content |
| SERP / keyword provider | Source SERP, PAA, volume and difficulty data |
| AI providers | OpenAI, Anthropic, Google and xAI through the adapter |

## 16. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Performance | Brief to publish-ready draft under 30 minutes; council round responses streamed to the UI |
| Scalability | Parallel agent calls; Celery queue for bulk and background jobs |
| Reliability | Retries with backoff and provider failover on every model call |
| Security | Encrypted API keys per project; role-based access; audit log of decisions and exports |
| Auth and billing | Accounts, roles (admin, editor, reviewer), quotas and rate limits |
| Observability | Structured logs, per-run cost and token metrics, error tracking |
| Compliance | House-rule pass/fail enforced before any live export |

## 17. UX and design requirements

- White content workspace with a dark navy left navigation; blue and purple AI accents; green for healthy scores, red for risk.
- Clean sans-serif typography (Inter or Geist); Linear, Notion and Ahrefs as references.
- Card-based layout for scores, agent outputs, warnings and recommendations.
- Split-screen article editor with the optimisation panel on the right.
- Debate Room presented as a chat-style thread of agent cards.

## 18. Analytics and evaluation loop

- Maintain a golden set of briefs with known-good outputs to regression-test agents.
- Compare published performance against scores to validate that the debate improves outcomes.
- Version agent prompts and measure changes against the golden set before rollout.

## 19. Release plan

| Phase | Scope |
| --- | --- |
| Phase 1 | Project setup, research, AI Debate Room and Judge, outline, single-article writer, eight scores, fact checker, export |
| Phase 2 | Provider failover and restricted routing, cost budgeting, originality score, house-rule engine, section regenerate and diff |
| Phase 3 | Bulk batch mode, internal-link engine, content memory at scale, multi-language, analytics and decay refresh, eval harness |

## 20. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Mainstream providers refuse restricted topics | Policy-tier routing and failover to permissive providers |
| Multi-model cost spirals | Cost tracking, budget caps, cost-aware routing, research caching |
| AI hallucination reaches publish | Fact checker with source and risk scoring; high-risk claims block the gate |
| Debate adds latency | Parallel Round 1, capped rounds, streamed responses |
| Reddit / data-source access restrictions | Define a concrete SERP and social data provider; degrade gracefully |
| Originality / AI-detection failures | Add an originality score before scaling output |

## 21. Open questions

- Which SERP and social data provider will back Research Intelligence?
- Is the Judge a fixed model or should it rotate between OpenAI and Claude per topic sensitivity?
- What is the per-article cost ceiling that triggers a downgrade in model routing?
- Which originality / AI-detection service is acceptable for restricted niches?

---

## Appendix A. Worked example — FeetFinder Review 2026

**Input.** Website spicyranked.com, topic FeetFinder Review 2026, keyword feetfinder reviews, goal: rank on Google and appear in AI answers, voice we-not-I.

**Research.** Intent detected as commercial investigation. Users want legitimacy, the 20% fee, payout trust (5 to 7 days), safety and alternatives. Trust sources: Trustpilot, Scamadviser.

**Debate.** Search Intelligence proposes a long FAQ for AI visibility; the Human Editor challenges it as repetitive and caps it; the Strategist merges FAQs into key buyer questions. The Judge rejects an unsupported safest-platform claim, accepts the 20% fee from FeetFinder terms, and merges in a payout-trust section.

**Output.** An outline with a Quick Verdict answer block, two comparison tables, a sourced complaints section and an FAQ. The draft states the 20% fee, 5 to 7 day payout and mandatory verification, with no em-dashes. Publish 87, Fact 81, zero high-risk claims, then exported to WordPress.

## Appendix B. Glossary

| Term | Meaning |
| --- | --- |
| SEO | Search Engine Optimisation — ranking in classic Google results |
| AEO | Answer Engine Optimisation — featured snippets and direct answers |
| GEO | Generative Engine Optimisation — visibility in AI engines like ChatGPT and Perplexity |
| HEO | Helpful Experience Optimisation — helpful-content quality and page experience |
| EEAT | Experience, Expertise, Authoritativeness, Trust |
| Council | The set of role-based AI agents that debate a brief |
| Judge | The agent that resolves the debate into final decisions |
| Publish gate | The score and fact thresholds an article must pass to publish |

---

*ContentOS AI — PRD v1.0 · Prepared by Tech Savy Crew for internal product planning.*
