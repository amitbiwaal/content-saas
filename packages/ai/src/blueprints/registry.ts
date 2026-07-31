/**
 * The content workflow registry.
 *
 * Deliberately the same shape as the Template Library (S4.1): an identity level
 * holding versions, monotonic integers as identity, semantic versions
 * alongside for compatibility, one active version per id, sealed at startup.
 * Two registries with the same job and different rules would be two things to
 * learn, and the second would be the one somebody got wrong.
 *
 * ── Two version numbers, for the reason S4.1 gives ─────────────────────────
 * The integer is IDENTITY: it is what the frozen runtime records as
 * `definitionVersion`, and what a run pins at start so a promotion mid-flight
 * cannot alter behaviour. The semantic version answers "is this compatible with
 * what I built against?", which the integer cannot.
 *
 * ── Registration validates the whole graph ─────────────────────────────────
 * A blueprint that cannot be walked is refused here rather than at execution.
 * That is the entire point of having definitions separate from runs.
 */

import type { AICapability } from '@contentos/contracts';

import type { ProviderRegistry } from '../providers/registry.js';
import type { PromptTemplateStatus } from '../prompts/template.js';
import type { TemplateLibrary } from '../templates/library.js';
import {
  formatSemanticVersion,
  isTemplateVisibility,
  parseSemanticVersion,
  type SemanticVersion,
} from '../templates/metadata.js';
import type { WorkflowCapability, WorkflowMetadata, WorkflowStepDefinition } from './steps.js';
import { validateBlueprint } from './validation.js';

/** One immutable version of a content workflow. */
export interface WorkflowVersion {
  /** Monotonic. Immutable once active — the runtime's `definitionVersion`. */
  readonly version: number;
  readonly semanticVersion: SemanticVersion;
  /** Draft, active or deprecated — the lifecycle the prompt registry uses. */
  readonly status: PromptTemplateStatus;
  readonly capability: WorkflowCapability;
  readonly entryStepId: string;
  readonly steps: readonly WorkflowStepDefinition[];
  readonly changelog: string;
}

/** The identity level: one id, its metadata, and every version of it. */
export interface ContentWorkflow {
  readonly id: string;
  readonly metadata: WorkflowMetadata;
  /** Ascending by monotonic version. Never empty. */
  readonly versions: readonly WorkflowVersion[];
}

/** What a caller registers. The registry derives and validates the rest. */
export interface ContentWorkflowDefinition {
  readonly id: string;
  readonly metadata: WorkflowMetadata;
  readonly versions: readonly {
    readonly version: number;
    /** `'2.1.0'`. Parsed and rejected here if it is not one. */
    readonly semanticVersion: string;
    readonly status: PromptTemplateStatus;
    readonly capability: WorkflowCapability;
    readonly entryStepId: string;
    readonly steps: readonly WorkflowStepDefinition[];
    readonly changelog: string;
  }[];
}

export const WORKFLOW_REGISTRY_ERROR_CODES = [
  'Sealed',
  'Empty',
  'DuplicateWorkflow',
  'DuplicateVersion',
  'InvalidMetadata',
  'InvalidVersion',
  'InvalidCapability',
  'InvalidBlueprint',
  'MultipleActiveVersions',
  'NonMonotonicVersions',
] as const;

export type WorkflowRegistryErrorCode = (typeof WORKFLOW_REGISTRY_ERROR_CODES)[number];

export class WorkflowRegistryError extends Error {
  readonly code: WorkflowRegistryErrorCode;
  /** Every blueprint issue, where registration failed on the graph. */
  readonly issues: readonly { readonly field: string; readonly code: string }[];
  constructor(
    code: WorkflowRegistryErrorCode,
    message: string,
    issues: readonly { readonly field: string; readonly code: string }[] = [],
  ) {
    super(message);
    this.name = 'WorkflowRegistryError';
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}

export function isWorkflowRegistryError(value: unknown): value is WorkflowRegistryError {
  return value instanceof WorkflowRegistryError;
}

export interface WorkflowRegistry {
  register(definition: ContentWorkflowDefinition): void;
  /** Throws on an unknown id — a workflow nobody declared is not substitutable. */
  get(id: string): ContentWorkflow;
  find(id: string): ContentWorkflow | null;
  has(id: string): boolean;
  list(): readonly ContentWorkflow[];
  byCapability(capability: AICapability): readonly ContentWorkflow[];
  version(id: string, version: number): WorkflowVersion | null;
  latestStable(id: string): WorkflowVersion | null;
  seal(): void;
  readonly sealed: boolean;
}

const ACTIVE: PromptTemplateStatus = 'active';
const DOT_CASE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

function assertMetadata(id: string, metadata: WorkflowMetadata): WorkflowMetadata {
  for (const [field, value] of [
    ['title', metadata.title],
    ['description', metadata.description],
    ['owner', metadata.owner],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new WorkflowRegistryError('InvalidMetadata', `Workflow '${id}' needs a ${field}.`);
    }
  }
  if (!isTemplateVisibility(metadata.visibility)) {
    throw new WorkflowRegistryError(
      'InvalidMetadata',
      `Workflow '${id}' has visibility '${String(metadata.visibility)}', which is not one of public, internal.`,
    );
  }
  const tags = [...new Set(metadata.tags.map((tag) => tag.trim().toLowerCase()))].filter(
    (tag) => tag !== '',
  );
  return Object.freeze({ ...metadata, tags: Object.freeze(tags.sort()) });
}

export interface WorkflowRegistryOptions {
  /** Resolved at registration, so a missing template fails here. */
  readonly library?: TemplateLibrary;
  readonly providers?: ProviderRegistry;
}

export function createWorkflowRegistry(
  definitions: readonly ContentWorkflowDefinition[] = [],
  options: WorkflowRegistryOptions = {},
): WorkflowRegistry {
  const ordered: ContentWorkflow[] = [];
  const byId = new Map<string, ContentWorkflow>();
  let sealed = false;

  const registry: WorkflowRegistry = {
    register(definition: ContentWorkflowDefinition): void {
      if (sealed) {
        throw new WorkflowRegistryError(
          'Sealed',
          `The registry is sealed; '${definition.id}' cannot be added. A run pins its definition at start, and a blueprint that changed mid-process would alter runs already in flight.`,
        );
      }
      if (!DOT_CASE.test(definition.id)) {
        throw new WorkflowRegistryError(
          'InvalidMetadata',
          `'${definition.id}' must be dot.case, e.g. 'article.draft'.`,
        );
      }
      if (byId.has(definition.id)) {
        throw new WorkflowRegistryError(
          'DuplicateWorkflow',
          `Workflow '${definition.id}' is registered twice; which one won would depend on registration order.`,
        );
      }
      if (definition.versions.length === 0) {
        throw new WorkflowRegistryError(
          'Empty',
          `Workflow '${definition.id}' declares no versions, so nothing could ever resolve to it.`,
        );
      }

      const versions: WorkflowVersion[] = [];
      const numbers = new Set<number>();
      let previous = 0;

      for (const entry of definition.versions) {
        const where = `${definition.id}@${String(entry.version)}`;

        if (!Number.isInteger(entry.version) || entry.version < 1) {
          throw new WorkflowRegistryError(
            'InvalidVersion',
            `${where} is not a monotonic version number.`,
          );
        }
        if (numbers.has(entry.version)) {
          throw new WorkflowRegistryError(
            'DuplicateVersion',
            `Workflow '${definition.id}' declares version ${String(entry.version)} twice.`,
          );
        }
        if (entry.version <= previous) {
          throw new WorkflowRegistryError(
            'NonMonotonicVersions',
            `Workflow '${definition.id}' lists version ${String(entry.version)} after ${String(previous)}; versions are monotonic and must be declared ascending.`,
          );
        }
        numbers.add(entry.version);
        previous = entry.version;

        const semanticVersion = parseSemanticVersion(entry.semanticVersion);
        if (semanticVersion === null) {
          throw new WorkflowRegistryError(
            'InvalidVersion',
            `${where} has semantic version '${entry.semanticVersion}'; the form is major.minor.patch.`,
          );
        }

        if (entry.changelog.trim() === '') {
          throw new WorkflowRegistryError(
            'InvalidVersion',
            `${where} has no changelog; a version nobody can explain is one nobody can roll back with confidence.`,
          );
        }

        // The whole graph, checked here so a blueprint that cannot be walked is
        // refused when it is cheap to fix.
        const validation = validateBlueprint({
          steps: entry.steps,
          entryStepId: entry.entryStepId,
          capability: entry.capability.capability,
          ...(options.library === undefined ? {} : { library: options.library }),
          ...(options.providers === undefined ? {} : { providers: options.providers }),
        });
        if (!validation.ok) {
          throw new WorkflowRegistryError(
            'InvalidBlueprint',
            `${where} is not a runnable blueprint: ${validation.issues
              .map((issue) => `${issue.field} ${issue.code}`)
              .join(', ')}.`,
            validation.issues,
          );
        }

        versions.push(
          Object.freeze({
            version: entry.version,
            semanticVersion,
            status: entry.status,
            capability: Object.freeze({ ...entry.capability }),
            entryStepId: entry.entryStepId,
            steps: Object.freeze(entry.steps.map((step) => Object.freeze({ ...step }))),
            changelog: entry.changelog,
          }),
        );
      }

      const active = versions.filter((version) => version.status === ACTIVE);
      if (active.length > 1) {
        throw new WorkflowRegistryError(
          'MultipleActiveVersions',
          `Workflow '${definition.id}' has ${String(active.length)} active versions; only one may be active, or "latest stable" is a coin toss that lands differently on each instance.`,
        );
      }

      const entry: ContentWorkflow = Object.freeze({
        id: definition.id,
        metadata: assertMetadata(definition.id, definition.metadata),
        versions: Object.freeze(versions),
      });
      ordered.push(entry);
      byId.set(entry.id, entry);
    },

    get(id: string): ContentWorkflow {
      const found = byId.get(id);
      if (found === undefined) {
        throw new WorkflowRegistryError('InvalidBlueprint', `No workflow '${id}'.`);
      }
      return found;
    },

    find: (id: string): ContentWorkflow | null => byId.get(id) ?? null,
    has: (id: string): boolean => byId.has(id),
    list: (): readonly ContentWorkflow[] => Object.freeze([...ordered]),

    byCapability: (capability: AICapability): readonly ContentWorkflow[] =>
      Object.freeze(
        ordered.filter((workflow) =>
          workflow.versions.some((version) => version.capability.capability === capability),
        ),
      ),

    version: (id: string, version: number): WorkflowVersion | null =>
      byId.get(id)?.versions.find((entry) => entry.version === version) ?? null,

    latestStable: (id: string): WorkflowVersion | null =>
      byId.get(id)?.versions.find((entry) => entry.status === ACTIVE) ?? null,

    seal(): void {
      if (sealed) return;
      if (ordered.length === 0) {
        throw new WorkflowRegistryError(
          'Empty',
          'An empty registry can produce nothing. Seal one with workflows, or do not build one.',
        );
      }
      sealed = true;
    },

    get sealed(): boolean {
      return sealed;
    },
  };

  for (const definition of definitions) registry.register(definition);
  return registry;
}

/** For an error message and a trace. Never parsed. */
export function describeWorkflowVersion(id: string, version: WorkflowVersion): string {
  return `${id}@${String(version.version)} (${formatSemanticVersion(version.semanticVersion)}, ${version.status})`;
}
