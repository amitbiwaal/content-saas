# Model Selection

> **Status:** v1.0 — complete. The authoritative model matrix. This document is versioned routing policy: changing it requires an ADR reference and a policy version bump.

## Overview

ContentOS uses four models, each with a deliberate role, all accessed **via OpenRouter under the AI Gateway**. No engine hardcodes a model; the Model Router applies this matrix.

## The Matrix

| Model | Role | Purpose |
|---|---|---|
| **Claude Sonnet** | Mid / Content tier | Code Generation · Content Writing · Architecture · Refactoring |
| **GPT-5** | Premium / Reasoning tier | Planning · Deep Reasoning · Strategy · Complex Analysis |
| **Gemini 2.5 Flash** | Fast / Cheap tier | Fast Tasks · Summaries · Classification · Translation · Cost Optimization |
| **Grok** | Alternative voice | Alternative Reasoning · Fresh Perspectives · Trend Analysis |

## Exclusions

> **DeepSeek is NOT used.** Any routing configuration, fallback chain, or code path referencing DeepSeek is a policy violation and a defect. Adding any new provider or model requires an ADR.

## Pipeline Stage → Model

| Stage | Primary model | Why |
|---|---|---|
| Keyword expansion, NLP terms | Gemini 2.5 Flash | High volume, low cost |
| SERP/structure extraction | Gemini 2.5 Flash | Extraction is a fast task |
| Competitor synthesis | GPT-5 | Strategic gap analysis |
| Planning (intent fast-path) | Gemini 2.5 Flash | Classification |
| Planning (clusters, outline) | GPT-5 | Deep reasoning + strategy |
| Writing (drafting, enrichment) | Claude Sonnet | Content writing strength |
| Review (fact/hallucination reasoning) | GPT-5 | Complex analysis |
| Review (voice, humanization) | Claude Sonnet | Writing-quality judgment |
| Trend analysis, refresh angles | Grok | Fresh perspective, trends |
| AI Council alternative pass | Grok | Independent second voice |
| Summaries, translation anywhere | Gemini 2.5 Flash | Cost optimization |

## Selection Principles

1. Cheapest model that meets the task's quality bar (Flash first for classification/extraction).
2. Premium reasoning (GPT-5) reserved for planning, synthesis, verification.
3. Content quality work goes to Claude Sonnet.
4. The AI Council always includes at least one non-primary model (Grok) for genuine diversity of judgment.
5. Fallbacks stay within this matrix: Sonnet ↔ GPT-5; Flash → Sonnet; Grok → GPT-5.

## Data Flow

Engine states a `task_type` → Router applies this matrix (plus budget/health/tenant overrides) → Gateway dispatches via OpenRouter → response records `model` and `policy_version`.

## Dependencies / Interfaces

Consumed by the Model Router as policy input; transport via `08-integrations/openrouter.md`. This file plus the Router's task table together are the complete, auditable routing truth.

## Implementation Notes

Model names are pinned to specific OpenRouter identifiers in config (exact snapshot ids live in config, not this doc, so version bumps don't require a doc edit — but tier assignments here are binding).

## Future Roadmap

Periodic bake-offs per task family; per-tenant premium-tier upgrades; regional model options.

## Open Questions

Embeddings model (not covered by the four above); direct-SDK fallback if OpenRouter degrades — tracked in `99-open-questions.md`.
