# Accessibility

> **Status:** v1.0 — complete. Phase 15 batch 3.
> **Accessibility is mandatory and asserted in CI.** It is not a review checklist, not a later pass, and not negotiable per screen. A build that fails an accessibility gate does not merge.

## Overview

**Purpose.** Define the accessibility implementation: keyboard patterns, focus management, screen-reader behaviour, live regions, error announcement, accessible tables, and testing.

**Scope.** Implementation detail. The targets — WCAG 2.2 AA, contrast ratios, the colour rule, target sizes, motion preferences, landmarks, heading structure — are set in `design-principles.md` and are referenced, not restated.

## Targets and enforcement

| Target | Value |
|---|---|
| Standard | **WCAG 2.2 Level AA** |
| Contrast | 4.5:1 body · 3:1 large text and UI components |
| Target size | 24×24 CSS px minimum |
| Enforcement | **CI gate — automated checks block the merge** |

**Automated checks catch roughly half of what matters**, and that is stated honestly rather than treated as full coverage. Contrast, missing labels, invalid ARIA, heading order, and landmark structure are machine-checkable. Focus order, announcement quality, and whether a live region is intelligible are not — those are covered by the manual protocol below.

**Every new component ships with its accessibility behaviour, not after it.** A component merged without keyboard support is a component that will not get it (`07-development-guide/code-review.md`).

## Keyboard navigation

**Every interactive element is reachable and operable by keyboard. No exceptions.**

| Pattern | Behaviour |
|---|---|
| `Tab` / `Shift+Tab` | Moves between focusable elements in **visual order** |
| `Enter` | Activates buttons and links |
| `Space` | Toggles checkboxes, switches; activates buttons |
| Arrow keys | Move within a composite — menu, tab list, radio group, grid |
| `Escape` | Closes the topmost layer |
| `Home` / `End` | First and last within a composite |

**DOM order matches visual order.** Where CSS reorders content, the DOM is reordered too — a visually-first element that is tab-last is disorienting and is a common failure of grid layouts.

**Composite widgets take one tab stop.** A tab list, menu, or toolbar is entered with `Tab` and navigated with arrows, so a table with twelve row actions does not cost twelve tab stops.

**No keyboard traps.** Every container that takes focus can be left by keyboard alone.

**Skip-to-content is the first focusable element on every page.**

**Custom shortcuts never override browser or assistive-technology bindings**, and none is the sole path to an action (`navigation.md`).

**Shortcuts are suspended while a text input has focus**, except `Escape` and submit — otherwise typing "g" in the draft editor navigates away.

## Focus management

| Event | Focus goes to |
|---|---|
| Dialog opens | The dialog; focus is **trapped** |
| Dialog closes | **The element that opened it** |
| Drawer opens | The drawer heading |
| Route change | The page `h1`, announced |
| Item deleted from a list | The next item, or the list heading if empty |
| Validation failure | **The first invalid field** |
| Async content arrives | **Nowhere — focus is never moved** |

**The last row is the one that matters most in this product.** A pipeline advancing while a user reads must not relocate their cursor. Runs complete, progress updates, and notifications arrive continuously — and none of them steals focus (`design-principles.md`).

**Focus is restored to the trigger on dialog close.** Returning focus to the document body loses the user's place entirely.

**Focus after deletion moves deliberately.** Focus landing on `body` after removing a row is the most common list-management accessibility bug.

**Focus is always visible.** `--border-focus` is a token and is never suppressed, including on mouse interaction — "focus-visible only" hides focus from users who mix input methods (`design-system.md`).

## Screen readers

**Tested against NVDA + Firefox, VoiceOver + Safari, and JAWS + Chrome.** Behaviour differs enough between combinations that one is not representative.

| Element | Requirement |
|---|---|
| Buttons, links, inputs | An accessible name that describes the action |
| Icon-only controls | A label — never an unlabelled glyph |
| Images | `alt` describing purpose; decorative images `alt=""` |
| **Media in the library** | Uses its label; **not the discarded original filename** |
| Landmarks | One `main`, plus navigation, complementary, contentinfo |
| Headings | One `h1`; no level skipped |

**Accessible names describe the action, not the icon.** "Delete article" — never "trash icon."

**Semantic HTML precedes ARIA.** A `<button>` needs no `role="button"`, and ARIA that duplicates native semantics is a source of contradiction rather than support.

**Where ARIA is required, it is complete.** A `role="tablist"` without `aria-selected` and `aria-controls` is worse than no ARIA, because it promises structure it does not deliver.

## Live regions

**The product streams progress continuously, which makes live-region discipline unusually important here.**

| Region | Politeness | Used for |
|---|---|---|
| Status | `polite` | Save confirmations, filter results, run phase changes |
| Alert | `assertive` | Errors requiring action, session expiry |
| Log | `polite` | Notification arrivals |

**Progress does not announce every update.** A run streaming percentage over SSE would produce continuous speech that renders the page unusable. Announcements fire on **phase change and terminal status only** — five phase transitions and one outcome per run (`research.md`).

**`assertive` is reserved for interruptions that are genuinely worth interrupting for.** An expiring session and a failed save qualify; a completed background run does not.

**Result counts are announced after filtering** — "14 articles" — because a silent list change leaves a screen-reader user unaware anything happened.

**Live regions exist in the DOM before content arrives.** A region inserted with its message is frequently not announced.

## Error announcement

| Error | Announcement |
|---|---|
| Field validation | `aria-describedby` on the field; focus moves to the first invalid field |
| Form-level | `role="alert"` at the form, listing affected fields |
| Server error | `role="alert"` including the **`requestId`** |
| Permission denied | `role="alert"` naming the missing permission |
| Not found | Announced with the page heading change |

**Validation errors are associated with their field, not announced globally.** A global "3 errors" leaves the user hunting.

**The `requestId` is announced and is copyable by keyboard.** It is how a screen-reader user gets support without reading a code visually (`error-and-loading-patterns.md`).

**Errors are announced once.** Re-rendering a form must not re-announce a persisting error on every keystroke.

## Accessible tables

**The product's core surfaces are tables — articles, runs, members, evidence, media.**

| Requirement | Implementation |
|---|---|
| Structure | Real `<table>`; never `<div>` grids |
| Caption | `<caption>` describing the table's contents |
| Headers | `<th scope="col">` and `<th scope="row">` |
| **Sort** | `aria-sort` on the active column; change announced |
| Selection | Checkbox with an accessible name identifying **the row**, not just "select" |
| Bulk bar | Selection count in a live region |
| Empty | The empty state is announced, not a blank body |
| **Responsive** | **Card transformation preserves the header–value association** |

**Row checkboxes name their row.** "Select" repeated forty times is unusable; "Select Espresso Machine Guide" is not.

**The card transformation below tablet keeps each value labelled**, since a card that drops the header leaves values unidentifiable.

**Sortable headers are buttons inside `<th>`**, so activation is keyboard-native and the sort state is announced on change.

## Product-specific patterns

**Four surfaces need explicit treatment because their meaning is easy to lose.**

**Gate verdicts** carry icon, text, and colour. The accessible name is the full verdict — "Blocked: three critical issues" — not "red badge" (`content.md`).

**Scores** announce value and confidence together: "SEO score 82 out of 100, confidence 91." A number alone loses the orthogonal confidence that ADR-021 makes central.

**The relationship graph has a keyboard-navigable list equivalent, always.** A canvas-only visualization is inaccessible, and the list is not a degraded fallback — it is an equal surface (`knowledge.md`).

**Run progress announces phase and outcome, never percentage.** Five transitions, one terminal announcement.

## Reduced motion and responsive behaviour

**`prefers-reduced-motion` removes or reduces animation to opacity changes.** Progress indicators become static with textual status; skeleton shimmer stops.

**Motion is never the sole indicator of a state change.** A pulsing badge that stops pulsing must also change its label.

**Responsive behaviour is an accessibility requirement, not only a layout one.** Content reflows to 320 px without horizontal scrolling; wide content — tables, diagrams, code — scrolls inside its own container while the page body does not (`design-principles.md`).

**Zoom to 200% does not break layout or hide content.**

**Nothing is desktop-only.** Outline approval gates the entire pipeline and must be completable from a phone.

## Forms

| Requirement | Detail |
|---|---|
| Labels | Persistent and visible — **never placeholder-as-label** |
| Required fields | Marked in text, not by colour or asterisk alone |
| Grouping | `<fieldset>` and `<legend>` for related controls |
| Autocomplete | Set on identity and address fields |
| Character counters | Associated with the field via `aria-describedby` |
| Submit | Never disabled pending validation — submitting reveals errors |

**A submit button disabled until valid hides why it cannot be pressed.** Allowing submission and announcing the errors is more usable and more accessible.

**The 2,000-character AI instructions counter is announced at thresholds**, not on every keystroke (`ai.md`).

## Testing

| Layer | Coverage |
|---|---|
| **CI — automated** | axe on every component and journey; contrast validation; **blocks the merge** |
| **CI — structural** | Landmarks, heading order, form labels, ARIA validity |
| **Manual — per release** | Keyboard-only traversal of every critical journey |
| **Manual — per release** | Screen-reader pass on the three tested combinations |
| **Manual — per quarter** | 200% zoom, reduced motion, 320 px width |

**Keyboard-only traversal covers the full journeys**: sign up → workspace → article → outline approval → publish; and upload → available → attach.

**A failing accessibility check is a build failure, not a warning.** A warning in an accessibility gate is a gate that erodes at exactly the rate people are busy (`07-development-guide/ci-cd.md`).

**Automated coverage is not claimed as complete.** The manual protocol exists because the checks cannot assess whether an announcement is intelligible.

## Business rules

1. **WCAG 2.2 AA is the target**, enforced by a blocking CI gate.
2. **Automated checks are not claimed as full coverage**; a manual protocol supplements them.
3. **Every interactive element is keyboard-operable**; no traps.
4. **DOM order matches visual order.**
5. **Composite widgets take one tab stop.**
6. **Focus is restored to the trigger** on dialog close.
7. **Async content never moves focus.**
8. **Focus is always visible**, including on mouse interaction.
9. **Semantic HTML precedes ARIA**; partial ARIA is worse than none.
10. **Progress announces phase and outcome, never percentage.**
11. **`assertive` is reserved for genuine interruptions.**
12. **Validation errors associate with their field**; `requestId` is announced and keyboard-copyable.
13. **Tables use real semantics**; row checkboxes name their row.
14. **The card transformation preserves header–value association.**
15. **Scores announce value and confidence together.**
16. **The relationship graph has an equal list surface**, not a fallback.
17. **Submit is never disabled pending validation.**
18. **Nothing is desktop-only.**

## Cross references

- `design-principles.md` — **targets, contrast, colour rule, target size, motion, landmarks**
- `design-system.md` — focus token, status badges with icon and text, table components
- `error-and-loading-patterns.md` — error announcement and `requestId`
- `navigation.md` — shortcuts, skip-to-content, no sole-path shortcuts
- `content.md` — gate verdicts and score announcement
- `research.md` — run phases and announcement cadence
- `knowledge.md` — the relationship graph's list equivalent
- `ai.md` — the instructions character counter
- `media.md` — media labels rather than discarded filenames
- `07-development-guide/ci-cd.md` — the blocking accessibility gate
- `07-development-guide/testing-guide.md` — journey coverage
