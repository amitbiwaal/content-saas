# Debate Engine

> **Status:** v1.0 — complete. Phase 17.
> **Editors debate Issues, never articles.** Every message is a typed operation against a specific Issue ID. There is no free-form conversation, because a conversation cannot be replayed, audited, or resolved deterministically.

## Overview

**Purpose.** Define structured disagreement: thread anchoring, the six operations, round bounds, outcome computation, and termination.

**Scope.** Thread mechanics. What may be challenged is `editor-roles.md`; how outcomes feed the decision is `consensus-engine.md`.

## What determinism means here

**Editor findings are not deterministic. Thread resolution is.**

| Not deterministic | Deterministic |
|---|---|
| Whether an editor challenges | **Whether a challenged Issue is upheld** |
| What an editor argues | **How the message set resolves** |
| Model output | **Outcome computation over that output** |

**Given the same message set, the outcome is always the same.** The resolution is pure computation over typed operations — no model is consulted to decide who won (`consensus-engine.md` applies the same principle).

**This is the same honesty the platform applies to the AI Council**: real conflict is detected, not synthesized, and the adjudication is structured (ADR-019).

## Thread anchoring

**A Debate Thread is anchored to exactly one Issue.**

```ts
interface DebateThread {
  readonly threadId: string;
  readonly issueId: string;              // exactly one — the anchor
  readonly runId: string;
  readonly roundNumber: number;
  readonly tenantId: string;
  readonly openedBy: EditorRole;
  readonly openedAt: string;
  readonly maxRounds: number;            // configured at open
  readonly outcome: DebateOutcome | null;
}
```

**One Issue, one thread, per editorial round.** A second challenge to the same Issue in the same round joins the existing thread rather than opening a competing one.

**A thread never spans Issues.** Where two Issues genuinely relate, the relationship is a **dependency** on the Issue, not a shared thread (`issue-model.md`). A thread spanning Issues would be a conversation about the article, which is precisely what this engine refuses.

**Threads are independent and resolve in parallel.** Each concerns one Issue owned by one editor, so there is no cross-thread ordering to reason about (`editorial-workflow.md`).

## The six operations

**Every message is one of six typed operations. Nothing else is accepted.**

```ts
type DebateMessage =
  | { op: 'CHALLENGE'; target: ChallengeTarget; argument: string; evidence: readonly EvidenceRef[] }
  | { op: 'SUPPORT'; argument: string; evidence: readonly EvidenceRef[] }
  | { op: 'MERGE'; withIssueId: string; rationale: string }
  | { op: 'SPLIT'; into: readonly SplitProposal[]; rationale: string }
  | { op: 'ESCALATE'; to: 'council' | 'human'; rationale: string }
  | { op: 'CLOSE'; proposedOutcome: DebateOutcome; rationale: string };

type ChallengeTarget = 'evidence' | 'confidence' | 'severity' | 'reasoning' | 'recommendation';
```

**Every message carries `sequence`, `byRole`, and `at`**, and the thread record is append-only. No message is edited or withdrawn.

### CHALLENGE

**Disputes one of five aspects of an Issue.**

| Target | Disputes |
|---|---|
| `evidence` | The cited evidence does not support the finding |
| `confidence` | The stated certainty is unwarranted |
| `severity` | The assigned severity is too high or too low |
| `reasoning` | The inference from evidence to finding is invalid |
| `recommendation` | The suggested resolution would not resolve it |

**A challenge names exactly one target.** Disputing "the whole Issue" is not expressible, because an unfocused challenge cannot be resolved — the outcome computation needs to know what was contested.

**A challenge without evidence is permitted but weighted lower.** An editor may reason from the draft alone; an editor citing contradicting evidence carries more weight in the computation.

**Category ownership is never challengeable.** An editor disputing another's right to raise a finding has misunderstood the board; the operation is rejected at validation (`editor-roles.md`).

### SUPPORT

**Endorses an Issue raised by another editor.**

**Support does not create a duplicate Issue.** It attaches weight to the existing one, which is how a finding that several editors independently recognise becomes harder to refute — without violating exclusive category ownership.

**An editor may support an Issue in a category it does not own.** Support is not authorship; it is corroboration, and the Issue's `raisedBy` and `category` are unchanged.

**Self-support is rejected.** The raising editor supporting its own Issue adds nothing and would let a single editor manufacture weight.

### MERGE

**Proposes combining two Issues into one.**

| Constraint | Rule |
|---|---|
| Category | **Both Issues must share one category** |
| Proposer | **Only the owning editor** |
| Result | A **new parent** Issue; both originals archived |
| Automatic | **Never** |

**Merge is restricted to one category and one owner** because a merged Issue must have exactly one category and one `raisedBy`. Two editors' findings are never merged; where they relate, the relationship is a dependency.

**The merged parent inherits the higher severity and the union of evidence**, and its `childIssueIds` name both originals. Nothing is lost.

### SPLIT

**Proposes decomposing one Issue into several.**

**Only the owning editor may split**, and every child stays in the parent's category.

**Split is the correct response to a compound finding** — an Issue that says "§3 has three unsupported claims" resolves ambiguously, because the Writer cannot partially resolve it. Three children resolve independently.

**The parent is archived; children are `Open`.**

### ESCALATE

**Requests adjudication beyond the board.**

| Target | Effect |
|---|---|
| `council` | **Convenes an AI Council** for bounded adjudication (ADR-019) |
| `human` | Sets `humanReviewRequired` on the Issue |

**Council escalation uses the platform's existing component**, inheriting its diversity enforcement, real conflict detection, disclosure, and cost budget. EIE does not reimplement any of it (`architecture.md`).

**Council escalation is bounded per run** and charges credits. An unbounded escalation path would make the board's cost unpredictable.

**Human escalation does not resolve the thread.** It marks the Issue and lets consensus route the run to `HUMAN_REVIEW_REQUIRED`; the thread itself terminates as `Escalated`.

### CLOSE

**Proposes terminating the thread with a stated outcome.**

**Only the owning editor may propose CLOSE**, and a close proposal that no other participant challenges in the following round takes effect.

**A contested close does not take effect** and the thread continues to the round cap.

## Round bounds

| Property | Value |
|---|---|
| Default max rounds | **2** |
| Configurable | Per workspace |
| A round | One message from each participating editor |
| Cap reached | **Thread terminates `Unresolved`** |

**Two rounds is the default because a third rarely changes the outcome and always costs.** An editor that has stated its position and responded once has said what it has; a further round is usually restatement.

**The cap is on debate rounds within an editorial round**, not on editorial rounds. A thread reaching its cap terminates; the editorial round continues to consensus.

**Debate is optional.** Most Issues are never challenged, and a round with no challenges proceeds directly to decision.

## Outcome computation

**Deterministic, computed over the message set, no model consulted.**

```ts
type DebateOutcome =
  | { kind: 'UPHELD' }
  | { kind: 'REFUTED' }
  | { kind: 'MODIFIED'; severity: Severity; confidence: number }
  | { kind: 'MERGED'; parentIssueId: string }
  | { kind: 'SPLIT'; childIssueIds: readonly string[] }
  | { kind: 'ESCALATED'; to: 'council' | 'human' }
  | { kind: 'UNRESOLVED' };
```

**The computation, in order:**

| Step | Rule |
|---|---|
| 1 | If any `ESCALATE` was accepted → **`ESCALATED`** |
| 2 | If an uncontested `MERGE` or `SPLIT` was proposed → **`MERGED`** / **`SPLIT`** |
| 3 | If an uncontested `CLOSE` was proposed → its proposed outcome |
| 4 | If challenges carry **evidence** and support does not → **`REFUTED`** |
| 5 | If support carries evidence and challenges do not → **`UPHELD`** |
| 6 | If both carry evidence → **higher hierarchy rank prevails** |
| 7 | If ranks are equal → **`MODIFIED`** with severity reduced one step |
| 8 | If the cap is reached with no resolution → **`UNRESOLVED`** |

**Evidence beats assertion.** Steps 4 and 5 are the computation's core: a challenge grounded in evidence defeats an ungrounded finding, and vice versa. This is the same principle the platform applies everywhere — a claim is supported only if it resolves to Evidence Bank content (ADR-009).

**Hierarchy breaks evidenced ties.** Where both sides cite evidence, the higher-ranked category prevails — a Safety challenge defeats a Readability defence (`editor-roles.md`).

**Equal-rank evidenced ties reduce severity by one step rather than picking a winner.** Two equally-ranked, equally-evidenced positions are genuine uncertainty, and asserting a winner would manufacture confidence the board does not have.

**Message ordering is by `sequence`, never arrival time**, so a replay produces the identical outcome.

## Unresolved escalates severity

**A thread that reaches its cap without resolution raises the Issue's severity by one step, capped at `HIGH`.**

| Before | After `UNRESOLVED` |
|---|---|
| `INFO` | `LOW` |
| `LOW` | `MEDIUM` |
| `MEDIUM` | `HIGH` |
| `HIGH` | `HIGH` |
| `CRITICAL` | `CRITICAL` |

**Unresolved disagreement is a signal, not noise.** Averaging it away would let a contested finding pass more easily than an uncontested one, which inverts the incentive — an editor could soften a finding by disputing it.

**Escalation stops at `HIGH`.** An unresolved debate should not manufacture a `CRITICAL` block; it should raise attention and let consensus decide, with `HUMAN_REVIEW_REQUIRED` available where the hierarchy warrants it.

**The severity change is recorded as a `MODIFIED` state transition on the Issue**, attributed to the thread — never as an edit to the Issue record (`issue-model.md`).

## Immutability

| Table | Mutability |
|---|---|
| `editorial_debates` | **Thread header, written once** |
| `editorial_debate_messages` | **Append-only**, `UNIQUE (thread_id, sequence)` |

**No message is edited or withdrawn.** A retracted position is a new message stating the retraction, which keeps the record complete.

**The outcome is written once at termination** and never recomputed. Recomputing on read would let a change to the computation silently rewrite history.

## Validation

| Check | Failure |
|---|---|
| Thread anchors exactly one Issue | Rejected |
| Operation is one of six | Rejected |
| `CHALLENGE` names exactly one target | Rejected |
| **`MERGE` targets share the anchor's category** | **Rejected** |
| **`MERGE` / `SPLIT` / `CLOSE` proposed by the owning editor** | **Rejected** |
| Self-`SUPPORT` | **Rejected** |
| Challenge to category ownership | **Rejected** |
| Evidence references resolve and are in-tenant | Rejected |
| Message would exceed the round cap | Rejected |

**Rejected, never repaired** — the same discipline applied to malformed Issues (`issue-model.md`).

## Observability

| Signal | Meaning |
|---|---|
| `editorial_debates_total{outcome}` | How disagreement resolves |
| **`editorial_debate_unresolved_total`** | **Disagreement the board cannot settle** |
| `editorial_debate_rounds` | Whether the cap is binding |
| `editorial_challenges_total{target}` | What editors actually dispute |
| `editorial_escalations_total{to}` | Council and human load |
| **`editorial_debates_zero_runs`** | **Runs with no debate at all** |

**A sustained zero-debate rate is a warning, not a success.** A board that never disagrees is either uniform in composition — the ADR-019 failure the Council was written to prevent — or is not genuinely reviewing. Model diversity is verified at dispatch, and a flat debate rate suggests that verification is not working (`provider-mapping.md`).

**A rising `UNRESOLVED` rate means the hierarchy or the evidence is inadequate.** It is the signal most worth acting on, because unresolved debates escalate severity and therefore block more drafts.

**`editorial_challenges_total{target}` shows what the board argues about.** Heavy `severity` challenging suggests miscalibrated editors; heavy `evidence` challenging suggests a retrieval gap.

## Business rules

1. **A thread anchors exactly one Issue; threads never span Issues.**
2. **Every message is one of six typed operations.**
3. **Editors debate Issues, never articles.**
4. **A `CHALLENGE` names exactly one of five targets.**
5. **Category ownership is never challengeable.**
6. **`SUPPORT` adds weight, never a duplicate Issue**; self-support is rejected.
7. **`MERGE` requires one shared category and the owning editor.**
8. **Merge and split are never automatic.**
9. **Only the owning editor may propose `CLOSE`**; a contested close does not take effect.
10. **Council escalation uses ADR-019's component**, bounded and budgeted.
11. **Default cap is two rounds**, configurable per workspace.
12. **Outcome computation is deterministic and consults no model.**
13. **Evidence beats assertion; hierarchy breaks evidenced ties.**
14. **Equal-rank evidenced ties reduce severity rather than pick a winner.**
15. **`UNRESOLVED` escalates severity one step, capped at `HIGH`.**
16. **Messages are append-only; nothing is edited or withdrawn.**
17. **The outcome is written once and never recomputed.**
18. **Zero debate across runs is a warning, not a success.**

## Cross references

- `issue-model.md` — the Issue a thread anchors to; state transitions
- `editor-roles.md` — hierarchy ranks used in tie-breaking
- `consensus-engine.md` — how outcomes feed the decision
- `confidence-engine.md` — the confidence a challenge may dispute
- `provider-mapping.md` — diversity verification behind meaningful debate
- `orchestration.md` — where debate sits in the workflow
- `implementation-guide.md` — table definitions
- `08-ai-platform/` — the AI Council escalation target
- `01-system-architecture/13-adr-log.md` — **ADR-019 real conflict detection**, ADR-009
