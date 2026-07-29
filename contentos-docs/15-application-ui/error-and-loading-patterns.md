# Error and Loading Patterns

> **Status:** v1.0 — complete. Phase 15 batch 3. **Canonical.**
> **Every screen uses these patterns. No screen redefines them.** A state rendered differently on two screens teaches users that the same signal means different things.

## Overview

**Purpose.** The canonical catalogue of sixteen UI states: what triggers each, how it renders, what actions it offers, and how it is announced.

**Boundary with `design-principles.md`.** That document owns the *reasoning* — why thresholds are where they are, why the server owns truth, why `404` renders as not-found. **This document owns the catalogue.** Values are identical in both; where a threshold appears here, it is the one set there.

## The catalogue

| # | State | Trigger |
|---|---|---|
| 1 | Loading | Request in flight |
| 2 | Skeleton | Load expected 2–10 s |
| 3 | Progress | Determinate work with a percentage |
| 4 | Optimistic | Mutation applied before confirmation |
| 5 | Pessimistic | Mutation awaiting confirmation |
| 6 | Retry | A failure that could plausibly succeed |
| 7 | Offline | Network unavailable |
| 8 | Maintenance | Planned unavailability |
| 9 | Conflict | `409` or `412` |
| 10 | Validation | `400` with field detail |
| 11 | Permission denied | `403` |
| 12 | Not found | `404` |
| 13 | Server error | `5xx` |
| 14 | Timeout | No response within the client budget |
| 15 | Cancellation | User-initiated stop |
| 16 | Run completion | Terminal run status |

---

## 1 · Loading

| Duration | Rendering |
|---|---|
| **< 300 ms** | **Nothing** |
| 300 ms – 2 s | Inline spinner, **scoped to the affected element** |
| 2 s – 10 s | Skeleton |
| **> 10 s** | **Not loading — a run** (state 16) |

**A flash of loading is worse than a brief wait.** Sub-300 ms indicators produce visible flicker on fast connections.

**Loading is scoped to what is loading.** A page never blanks because one widget is refetching; dashboard widgets render their states independently (`dashboard.md`).

**Cached data renders immediately and refreshes underneath** with a subtle indicator. Blanking known-good content trades certainty for uncertainty.

**Announcement:** none for sub-2 s; a polite "Loading" for longer.

## 2 · Skeleton

| Rule | Detail |
|---|---|
| Shape | **Matches the eventual layout exactly** |
| Count | Approximates the expected item count |
| Motion | Shimmer; **static under `prefers-reduced-motion`** |
| Never | Nested skeletons; skeletons for content that may be empty |

**A skeleton whose shape differs from the loaded content causes a reflow that reads as instability.**

**Skeletons are not used where the result may be empty.** A skeleton implies content is coming; rendering the empty state directly is more honest (`design-principles.md`).

## 3 · Progress

| Type | Use |
|---|---|
| Determinate bar | Uploads, replays, anything with a real percentage |
| **Phase indicator** | **Runs — five coarse phases only** |
| Indeterminate | Work with no measurable percentage |

**Run progress renders `preparing`, `gathering`, `analyzing`, `synthesizing`, `finalizing` — never a stage name** (`research.md`).

**Progress never regresses.** A percentage that goes backwards destroys confidence; where an estimate is revised, the bar holds rather than reverses.

**Announcement:** phase changes and terminal status only — never percentage (`accessibility.md`).

## 4 · Optimistic

**Permitted only where reversal is free and the server cannot legitimately refuse.**

| Operation | Optimistic |
|---|---|
| Filter, sort, expand, collapse | **Yes** — pure client state |
| Rename, edit metadata | **Yes, with rollback** |
| Mark notification read | **Yes** |
| Everything else | **No** |

**Rollback is visible, never silent.** A failed rename shows the old value **and the reason**, or the user believes a change persisted that did not.

**Announcement:** rollback is announced assertively — it reverses something the user believes happened.

## 5 · Pessimistic

**Required wherever the server can legitimately say no.**

| Operation | Reason |
|---|---|
| **Create anything** | Needs the server's id |
| **Any credit-charging action** | Optimistic success on a `402` is a lie about money |
| **Publish** | Gate verdict is verified server-side, per revision |
| **Delete** | May be refused — references, legal hold, published content |
| **Anything with `If-Match`** | `412` is a real outcome |
| **Anything with `Idempotency-Key`** | Exactly the operations that create, charge, or trigger irreversible work |

**The control is disabled while in flight and shows a spinner**, preventing double submission without relying on the user not to click twice.

## 6 · Retry

| Condition | Retry offered |
|---|---|
| `5xx`, `503` | **Yes** — honours `Retry-After` |
| Network failure | **Yes** |
| **Timeout** | **Only with `Idempotency-Key`** — see state 14 |
| `429` | Yes, after `Retry-After` |
| **Any other `4xx`** | **No** |
| **Guardrail block, safety refusal, grounding failure** | **No** |

**Retry is never offered where retrying cannot succeed.** A `409 CONTENT_GATE_BLOCKED` does not become valid on retry, and a guardrail decision is deterministic (`ai.md`, `13-event-platform/retry-engine.md`).

**Retry never silently re-submits.** It is always a user action.

**Automatic retry with backoff applies to idempotent `GET`s only**, up to three attempts, and is invisible.

## 7 · Offline

| Surface | Behaviour |
|---|---|
| Reads | Cached content, **marked stale** |
| Mutations | **Disabled with a reason** |
| **Queuing** | **Nothing queues — with one exception** |
| **Exception** | **Notification read state**, which is idempotent and negligible if lost |
| In-flight runs | **Continue server-side**; UI shows "reconnecting" |
| Draft editor | **Read-only; unsaved content preserved locally, never auto-submitted** |

**Queuing mutations is refused deliberately.** A queued role change, replay, or publish applied later against changed state is worse than a clear failure — the server may legitimately refuse it, and the user is no longer present to see.

**A dropped SSE connection never renders a run as failed.** The UI shows reconnecting, keeps last known state, and reconciles by refetching (`research.md`).

**Announcement:** assertive on transition to offline; polite on recovery.

## 8 · Maintenance

| Rule | Detail |
|---|---|
| Rendering | Full-screen or banner, with **expected return time** |
| Reads | **Remain available where possible** |
| Mutations | Disabled with the reason |
| Source | System announcement (`notifications.md`) |
| Operator console | Health and status remain; mutations disabled |

**Maintenance is distinguished from an outage.** Planned unavailability states a return time; an unplanned failure renders state 13.

## 9 · Conflict

| Code | Rendering |
|---|---|
| **`412`** | "Someone else changed this" — **reload offered, never auto-merge** |
| `428` | Precondition required — refetch and retry |
| `409` + state | The blocking state and the resolving action |
| `409` + reference | The **count and the holders** |

**`412` is never auto-merged.** Silently overwriting is the lost-update bug `If-Match` exists to prevent.

**`409` is actionable, not an error.** Run in progress, published content exists, last Owner, merge conflict — each names what resolves it, and where possible links to the blocking entity (`content.md`, `knowledge.md`).

**Announcement:** assertive — the user's intent did not take effect.

## 10 · Validation

| Rule | Detail |
|---|---|
| Placement | **Inline at the field**, using the returned `details[].path` |
| Never | A global toast for a field error |
| Focus | Moves to the **first** invalid field |
| Association | `aria-describedby` |
| Client-side | Mirrors the server schema; **never the only check** |
| Submit | **Never disabled pending validation** |

**A submit button disabled until valid hides why it cannot be pressed.** Allowing submission and revealing errors is more usable and more accessible (`accessibility.md`).

**Values are never echoed back.** The API returns paths and codes, not received values, and the UI does not reconstruct them (`06-api/api-principles.md`).

## 11 · Permission denied

| Situation | Rendering |
|---|---|
| **Within the tenant** | `403` — names the missing permission **and who can grant it** |
| **Cross-tenant** | **State 12 — not found** |
| Affordance | **Absent, not disabled** |
| Step-up needed | **A challenge, not an error** |

**Permission-blocked affordances are absent; state-blocked affordances are disabled with a reason.** The user can act on the second and never on the first (`navigation.md`).

**`401 SECURITY_STEP_UP_REQUIRED` renders an inline factor prompt**, not a navigation away that loses the form (`settings.md`).

## 12 · Not found

| Rule | Detail |
|---|---|
| Message | **"Not found" — never a permission message** |
| Cross-tenant | Renders identically to a genuinely missing resource |
| **Deleted within grace** | **A distinct state** — shows deleted, offers restore |
| Purged / expired | "No longer available," with the retention window stated |
| Sign-in redirect | Preserves the full path and query |

**This is a security requirement, not a UX preference.** A `403` would confirm the resource exists in another tenant, letting an attacker enumerate the customer base (`16-security/authorization.md`).

**Deleted-within-grace is honest and distinct.** A link to a deleted article shows it as deleted with restore, rather than pretending it never existed (`information-architecture.md`).

## 13 · Server error

| Rule | Detail |
|---|---|
| Message | Generic, derived from the stable `code` |
| **`requestId`** | **Always shown, always copyable in one action** |
| Never rendered | Stack traces, SQL, provider messages, internal hostnames |
| Retry | Offered |
| Placement | Banner at the action; **never a toast** |

**`requestId` is how support recovers full detail without the platform disclosing any** (`07-development-guide/error-handling.md`).

**Clients branch on `error.code`, never on message text.** Codes are contract; messages are not.

**Announcement:** assertive, including the `requestId`.

## 14 · Timeout

**The subtlest state, because the request may have succeeded.**

| Method | Behaviour |
|---|---|
| `GET` | Retry automatically, up to three attempts |
| **Mutation with `Idempotency-Key`** | **Retry is safe** — the original response is returned |
| **Mutation without `Idempotency-Key`** | **Do not retry** — refetch and show current state |

**This is where idempotency keys earn their place in the UI.** A timed-out `POST /runs` carrying a key can be retried safely: the server returns the original response rather than starting a second run. Without a key, retrying risks a duplicate charge, so the UI refetches and lets the user see what actually happened (`06-api/api-principles.md`).

**The message is honest about uncertainty:** "We didn't get a response. Checking the current state." Reporting failure would be wrong, and reporting success would be worse.

## 15 · Cancellation

| Rule | Detail |
|---|---|
| Rendering | **"Cancelling…" is a real intermediate state** |
| Semantics | **Cooperative** — completes at a safe point |
| Committed work | **Not rolled back**, stated in the confirmation |
| Credits | Retained for work performed; released for the rest |
| Affordance | Driven by `cancellable` on the run |
| Already complete | `409` — "this run already finished" |

**Cancellation is not instant and the UI does not imply it is** (`research.md`).

**`409` on cancelling a completed run is not silent success.** Unlike `DELETE`, the intent cannot be satisfied — the work already happened.

## 16 · Run completion

| Status | Rendering |
|---|---|
| `completed` | Result linked; **notification if the user navigated away** |
| `failed` | Reason, `requestId`, **"Run again"** — a new run, not a resume |
| `cancelled` | Cancelled with the credit outcome |
| `awaiting_input` | **A required action, not progress** |

**"Run again" creates a new run, charges again, and produces a new id.** There is no retry endpoint, and labelling it "Retry" would imply a resume that does not exist (`research.md`, `ai.md`).

**Completion while the user is elsewhere produces an inbox entry**, because a terminal outcome is a fact worth recording (`notifications.md`).

**Announcement:** polite on completion; assertive on failure.

## Cross-state rules

1. **No screen redefines a pattern in this catalogue.**
2. **Errors map from stable codes**, never parsed messages.
3. **`requestId` accompanies every `5xx`** and is keyboard-copyable.
4. **Retry is offered only where retrying could plausibly succeed.**
5. **Timeouts retry only with an idempotency key.**
6. **Offline queues nothing except notification read state.**
7. **Optimistic rollbacks are visible and announced.**
8. **`412` is never auto-merged.**
9. **`409` is actionable and names its resolution.**
10. **Cross-tenant denial renders as not-found.**
11. **Permission-blocked affordances are absent; state-blocked are disabled with a reason.**
12. **Submit is never disabled pending validation.**
13. **Values are never echoed in validation messages.**
14. **Skeletons match the eventual layout** and are not used where empty is likely.
15. **Progress never regresses**; runs announce phase and outcome only.
16. **Toasts never carry errors requiring action or long-running status.**

## Empty states — the four

**Never conflated**, because each has a different resolution:

| State | Message | Action |
|---|---|---|
| **Nothing created yet** | Explains the feature | Primary create action |
| **Filtered to nothing** | Names the active filters | Clear filters |
| **No permission** | Neutral; **no count** | Request access, where applicable |
| **Failed to load** | Error with `requestId` | Retry |

**A user who filtered to nothing and sees "Create your first article" concludes their work is gone.**

**No-permission empties leak no count.** "12 items hidden" tells the user something exists that they cannot see.

## Cross references

- `design-principles.md` — **the reasoning behind every threshold and rule here**
- `design-system.md` — the components rendering these states
- `accessibility.md` — announcement, focus on validation, live regions
- `07-development-guide/error-handling.md` — **stable codes; codes are contract**
- `06-api/api-principles.md` — status codes, `requestId`, idempotency, `If-Match`
- `16-security/authorization.md` — 404-versus-403
- `research.md` — run states, cancellation, "Run again"
- `ai.md` — non-retryable failure classes
- `notifications.md` — toasts, completion notifications, offline read state
- `dashboard.md` — independent widget states
