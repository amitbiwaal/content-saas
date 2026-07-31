/**
 * The content draft — editable work, before anything is executed.
 *
 * ── A draft is an identity plus its revisions ──────────────────────────────
 * The same shape a workflow (S4.2) and a library template (S4.1) already use:
 * one id, some metadata, and an ascending list of immutable versions. A third
 * arrangement for the same idea would be a third thing to learn.
 *
 * ── Every revision is frozen, and an update APPENDS ────────────────────────
 * There is no setter, no mutator and no in-place path anywhere in this module.
 * `revise` returns a new draft whose revision list is one longer; the previous
 * draft is untouched and still valid. Editing history is what makes "who
 * changed this, and to what" answerable at all, and a draft that could be
 * rewritten in place would answer it wrongly and confidently.
 *
 * ── The pinned references never move ───────────────────────────────────────
 * Workflow id, workflow version and template references are fixed when the
 * draft is created. A revision may change the INPUTS, the title and the status,
 * and nothing else. The point of pinning is that the thing the user saw is the
 * thing that runs; a draft whose workflow silently advanced a version is a
 * draft that means something different from what was on screen. Wanting a
 * different workflow is wanting a different draft.
 *
 * ── It stores identity, never authority ────────────────────────────────────
 * The same line S4.4 draws for a stored run: who created it and how they proved
 * it, never the roles or permissions they held. Those are resolved per request
 * from live bindings, and a written-down copy is a stale one that reads like a
 * grant.
 */

import type { AICapability } from '@contentos/contracts';

import type { StoredPromptReference } from '../runs/stored.js';
import { INITIAL_DRAFT_STATUS, type DraftStatus } from './status.js';

/** Whose draft it is, and what it is called. Identity only — see the header. */
export interface DraftMetadata {
  readonly organizationId: string;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspaceId: string;
  readonly principalId: string;
  readonly principalKind: string;
  /** What a person calls it. Never interpreted. */
  readonly title: string;
  readonly tags: readonly string[];
}

/**
 * One immutable revision.
 *
 * `revision` is a monotonic integer, the same identity-and-anchor role
 * `promptVersion` and `definitionVersion` play elsewhere: revision 3 of a draft
 * is one exact thing forever, and a semantic version would invite a judgement
 * about whether two edits were "compatible", which is not a question a draft
 * has.
 */
export interface DraftVersion {
  /** 1-based, ascending, no gaps. */
  readonly revision: number;
  readonly status: DraftStatus;
  /** UNTRUSTED. What a person typed, bound to the templates' declared slots. */
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly title: string;
  /** Why this revision exists. A change nobody can explain is one nobody can undo. */
  readonly note: string;
  readonly createdAt: string;
}

export interface ContentDraft {
  readonly draftId: string;
  readonly metadata: DraftMetadata;
  /** Fixed at creation. See the header for why it never moves. */
  readonly workflowId: string;
  /** The monotonic identity the run will pin. */
  readonly workflowVersion: number;
  /** `'article.draft@2'`. */
  readonly workflowRef: string;
  readonly capability: AICapability;
  /**
   * The template versions this draft resolved when it was created.
   *
   * Recorded so compilation can check they still resolve the same way. The
   * frozen orchestrator resolves templates itself, so this is not a
   * pin it can enforce — it is the pin compilation enforces on its behalf.
   */
  readonly templateReferences: readonly StoredPromptReference[];
  /** Ascending by revision. Never empty. */
  readonly revisions: readonly DraftVersion[];
  readonly createdAt: string;
  /** When the newest revision was made. */
  readonly updatedAt: string;
}

/** Frozen through, not merely readonly: a cast erases readonly, not this. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** The revision that is current. Never undefined — a draft always has one. */
export function latestRevision(draft: ContentDraft): DraftVersion {
  // Non-null by construction: `createDraft` starts at one and `revise` only
  // ever appends. A draft with no revisions never leaves this module.
  return draft.revisions[draft.revisions.length - 1] as DraftVersion;
}

export function draftStatus(draft: ContentDraft): DraftStatus {
  return latestRevision(draft).status;
}

/** `'article.draft@2'` for the workflow this draft is against. */
export function describeDraft(draft: ContentDraft): string {
  return `draft '${draft.draftId}' (${draft.workflowRef}, revision ${String(
    latestRevision(draft).revision,
  )})`;
}

export interface NewDraftOptions {
  readonly draftId: string;
  readonly metadata: DraftMetadata;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly workflowRef: string;
  readonly capability: AICapability;
  readonly templateReferences: readonly StoredPromptReference[];
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Supplied. Nothing in this module reads a clock. */
  readonly now: string;
  readonly note?: string;
}

/** A draft at revision 1. Frozen through; nothing here mutates anything. */
export function newDraft(options: NewDraftOptions): ContentDraft {
  const revision: DraftVersion = {
    revision: 1,
    status: INITIAL_DRAFT_STATUS,
    inputs: { ...options.inputs },
    title: options.metadata.title,
    note: options.note ?? 'Created.',
    createdAt: options.now,
  };

  return deepFreeze({
    draftId: options.draftId,
    metadata: { ...options.metadata, tags: [...options.metadata.tags] },
    workflowId: options.workflowId,
    workflowVersion: options.workflowVersion,
    workflowRef: options.workflowRef,
    capability: options.capability,
    templateReferences: options.templateReferences.map((reference) => ({ ...reference })),
    revisions: [revision],
    createdAt: options.now,
    updatedAt: options.now,
  });
}

export interface RevisionChanges {
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly title?: string;
}

export interface AppendRevisionOptions {
  readonly draft: ContentDraft;
  readonly status: DraftStatus;
  readonly changes?: RevisionChanges;
  readonly note: string;
  readonly now: string;
}

/**
 * A draft with one more revision. The previous one is untouched and valid.
 *
 * Inputs are REPLACED, not merged. A merge would make removing a value
 * impossible to express, and "the field I cleared came back" is the kind of
 * bug nobody reports because nobody believes it.
 */
export function appendRevision(options: AppendRevisionOptions): ContentDraft {
  const { draft, changes } = options;
  const current = latestRevision(draft);

  const revision: DraftVersion = {
    revision: current.revision + 1,
    status: options.status,
    inputs: { ...(changes?.inputs ?? current.inputs) },
    title: changes?.title ?? current.title,
    note: options.note,
    createdAt: options.now,
  };

  return deepFreeze({
    ...draft,
    metadata: { ...draft.metadata, title: revision.title },
    revisions: [...draft.revisions, revision],
    updatedAt: options.now,
  });
}
