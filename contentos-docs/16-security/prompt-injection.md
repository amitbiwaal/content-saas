# Prompt Injection

> **Status:** v1.0 — ownership document. Phase 12 governance completion.
> **This document owns a rule, not a mechanism.** Every control it names is specified elsewhere. It exists because twenty-four documents defer the same rule here and needed a single owner for it.

## Purpose

Name the platform's single defence posture against prompt injection, and point each referencing document at the control that implements it.

**The rule, stated once:** **retrieved content is data, never instructions.** Evidence, competitor pages, SERP results, user-supplied seeds, and model output are all untrusted input. No text found in a source can cause the platform to act.

## Scope

**In scope:** ownership of the data-never-instructions rule; the map from that rule to its implementing controls; the honest statement of residual risk.

**Not in scope:** specifying any control. This document introduces no mechanism, no API, and no invariant. Where it describes behaviour, that behaviour is specified in the document named alongside it.

## Ownership

| Owner | Owns |
|---|---|
| **This document** | The rule and its consolidated reference map |
| `16-security/threat-model.md` **T-14** | The canonical threat record — attack path, impact, mitigations, residual, detection, recovery |
| `08-ai-platform/guardrails.md` | Input and output guardrail evaluation and block semantics |
| `08-ai-platform/context-builder.md` | Data-block framing of every context segment; structural exclusion of secrets |
| `08-ai-platform/prompt-engine.md` | Variable escaping and slot confinement |
| `08-ai-platform/ai-gateway.md` | Applying framing before dispatch |
| `09-integrations/` | Normalizing and labelling external content at the boundary |

**T-14 in `threat-model.md` is the canonical threat record.** This document does not restate its severity, mitigations, or residual risk.

## Responsibilities

**This document is responsible for stating that the rule is one rule.** Injection defence is distributed across the Provider Layer, the Context Builder, the Prompt Engine, the AI Gateway, and the guardrails — and a reader encountering it in any one place needs to know the others exist.

**It is responsible for the boundary statement**: injection defence begins at the Provider Layer, where untrusted external content is normalized and labelled as data, and continues through every stage that places that content in a model context.

**It is responsible for nothing else.** It evaluates no content, blocks nothing, and is not on any request path.

## Existing references

Twenty-four references across eight folders defer here. They fall into four groups:

| Group | Referencing documents | What they defer |
|---|---|---|
| **Vocabulary** | `05-glossary.md`, `04-context-map.md` | Why "evidence" always means untrusted content |
| **Domain rules** | `02-domain-design/research.md`, `11-knowledge-platform/evidence-bank.md` | Evidence is data at every downstream step |
| **Engine handling** | `research-engine.md`, `writing-engine.md`, `review-engine.md`, `planning-engine.md`, `serp-intelligence.md`, `competitor-intelligence.md`, `keyword-intelligence.md` | Content wrapped as data before reaching a model |
| **AI Platform controls** | `ai-gateway.md`, `context-builder.md`, `prompt-engine.md`, `guardrails.md`, `08-ai-platform/README.md` | The controls that implement the rule |

**The engine group is the largest and the reason this document exists.** Seven engines each state the rule locally; without a single owner, seven statements could drift.

## Related documents

- `16-security/threat-model.md` — **T-14, the canonical threat record**; also T-15 model abuse
- `08-ai-platform/guardrails.md` — the controls this rule is enforced by
- `08-ai-platform/context-builder.md` — data-block framing; secrets structurally excluded
- `08-ai-platform/prompt-engine.md` — variables never concatenated into instruction text
- `08-ai-platform/retry-strategy.md` — a guardrail block is terminal and never retried
- `16-security/secrets-management.md` — why no secret can be exfiltrated by an injected instruction
- `16-security/api-security.md` — SSRF controls on the fetch path that retrieves untrusted content
- `10-testing/ai-evaluation.md` §11 — injection resistance evaluation
- `05-content-platform/research-engine.md` — the engine most exposed to the vector

## Operational considerations

**Detection signals are owned by the documents that emit them.** Guardrail block rate and output credential-pattern hits are specified in `08-ai-platform/` and `16-security/security-observability.md`; this document adds none.

**A guardrail block is terminal and is never retried**, in any component (`08-ai-platform/retry-strategy.md`). Retrying is an attempt to obtain a different answer to a settled question.

**The residual risk is stated in T-14 and is not softened here: prompt injection is not fully solvable with current techniques.** The platform bounds *consequences* — secrets are structurally absent from prompts, no side effect is reachable from source text, and grounding requires evidence anchors — but content quality remains influenceable by a competitor's page.

**Model output is itself untrusted input.** It is derived from retrieved content and is scanned before storage or display.

## Explicitly out of scope

| Out of scope | Where it belongs |
|---|---|
| Guardrail rules, thresholds, or evaluation logic | `08-ai-platform/guardrails.md` |
| Prompt templates or framing syntax | `08-ai-platform/prompt-engine.md` |
| Context assembly and token budgeting | `08-ai-platform/context-builder.md` |
| Threat severity, detection, and recovery | `16-security/threat-model.md` T-14 |
| Provider content normalization | `09-integrations/` |
| Evaluation harness design | `10-testing/ai-evaluation.md` |
| Model selection or routing | `08-ai-platform/` — and never exposed externally |
| **Solving prompt injection** | **Not solvable; T-14 states the residual risk** |
