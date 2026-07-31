/**
 * The draft lifecycle.
 *
 *   DRAFT ⇄ READY → SUBMITTED
 *     ↓       ↓
 *      DISCARDED
 *
 * ── Why READY is a state and not a computed property ───────────────────────
 * A draft is READY because it was validated against a registry and a library
 * AT A MOMENT. Recomputing it on read would make "ready" mean "ready right
 * now", which is a different and much weaker claim: a template promoted in
 * between would silently un-ready a draft somebody is looking at. Recording it
 * means an edit has to go through a transition, and the transition is where the
 * validation happens.
 *
 * ── Editing a READY draft returns it to DRAFT ──────────────────────────────
 * That is the whole reason the arrow points both ways. An edit invalidates the
 * validation that made it ready; leaving it READY would let a draft carry a
 * claim about content it no longer holds.
 *
 * ── SUBMITTED is terminal ──────────────────────────────────────────────────
 * Once a draft has been compiled into a run request and handed over, it is the
 * record of what was submitted. Editing it afterwards would rewrite the
 * provenance of a run that already happened — the draft and the run would
 * disagree, and the draft would win, because it is the one somebody reads.
 */

export const DRAFT_STATUSES = ['draft', 'ready', 'submitted', 'discarded'] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export function isDraftStatus(value: unknown): value is DraftStatus {
  return typeof value === 'string' && (DRAFT_STATUSES as readonly string[]).includes(value);
}

export const TERMINAL_DRAFT_STATUSES: readonly DraftStatus[] = Object.freeze([
  'submitted',
  'discarded',
]);

export function isTerminalDraftStatus(status: DraftStatus): boolean {
  return TERMINAL_DRAFT_STATUSES.includes(status);
}

export const DRAFT_TRANSITIONS = ['edit', 'ready', 'submit', 'discard'] as const;

export type DraftTransition = (typeof DRAFT_TRANSITIONS)[number];

export interface DraftTransitionRule {
  readonly from: DraftStatus;
  readonly transition: DraftTransition;
  readonly to: DraftStatus;
}

/**
 * The whole machine, as data.
 *
 * `edit` is legal from DRAFT as well as from READY: most revisions are one
 * draft edit after another, and a machine that only allowed editing a READY
 * draft would make the ordinary case the exceptional one.
 */
export const DRAFT_TRANSITION_RULES: readonly DraftTransitionRule[] = Object.freeze([
  { from: 'draft', transition: 'edit', to: 'draft' },
  { from: 'ready', transition: 'edit', to: 'draft' },

  { from: 'draft', transition: 'ready', to: 'ready' },
  { from: 'ready', transition: 'ready', to: 'ready' },

  { from: 'ready', transition: 'submit', to: 'submitted' },

  { from: 'draft', transition: 'discard', to: 'discarded' },
  { from: 'ready', transition: 'discard', to: 'discarded' },
]);

export const INITIAL_DRAFT_STATUS: DraftStatus = 'draft';

export const DRAFT_ERROR_CODES = ['IllegalTransition', 'InvalidDraft'] as const;

export type DraftErrorCode = (typeof DRAFT_ERROR_CODES)[number];

export class DraftError extends Error {
  readonly code: DraftErrorCode;
  constructor(code: DraftErrorCode, message: string) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
  }
}

export function isDraftError(value: unknown): value is DraftError {
  return value instanceof DraftError;
}

/** Where a transition leads, or null when it is not allowed from here. */
export function targetOf(from: DraftStatus, transition: DraftTransition): DraftStatus | null {
  return (
    DRAFT_TRANSITION_RULES.find((rule) => rule.from === from && rule.transition === transition)
      ?.to ?? null
  );
}

export function canTransition(from: DraftStatus, transition: DraftTransition): boolean {
  return targetOf(from, transition) !== null;
}

/** Every transition available from a state. For an error message and a test. */
export function transitionsFrom(from: DraftStatus): readonly DraftTransition[] {
  return Object.freeze(
    DRAFT_TRANSITION_RULES.filter((rule) => rule.from === from).map((rule) => rule.transition),
  );
}

/**
 * Assert and resolve. Throws rather than returning null, because every caller
 * is about to move a draft and a forgotten null check would move it anyway.
 */
export function assertTransitionAllowed(
  from: DraftStatus,
  transition: DraftTransition,
): DraftStatus {
  const to = targetOf(from, transition);
  if (to === null) {
    const available = transitionsFrom(from);
    throw new DraftError(
      'IllegalTransition',
      `A draft in '${from}' cannot '${transition}'. ${
        available.length === 0 ? `'${from}' is terminal.` : `Available: ${available.join(', ')}.`
      }`,
    );
  }
  return to;
}
