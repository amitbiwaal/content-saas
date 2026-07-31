import { describe, expect, it } from 'vitest';

import { createWorkflowRegistry, type ContentWorkflowDefinition } from '../blueprints/registry.js';
import type { WorkflowStepDefinition } from '../blueprints/steps.js';
import type { PromptTemplate } from '../prompts/template.js';
import { createTemplateLibrary, type TemplateLibrary } from '../templates/library.js';
import { resolveWorkflow } from '../blueprints/resolve.js';
import { appendRevision, newDraft, type ContentDraft, type DraftMetadata } from './draft.js';
import { requiredInputsFor, validateDraft } from './validation.js';

const AT = '2026-07-31T12:00:00.000Z';

// ── Templates ───────────────────────────────────────────────────────────────

const VARIABLES: Readonly<Record<string, PromptTemplate['variables']>> = {
  'planning.outline': [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
    { name: 'tone', type: 'string', required: false, description: 'How it should read.' },
  ],
  'writing.draft': [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
    // Bound by the step before it — never typed by a person.
    { name: 'outline', type: 'string', required: false, description: 'The bound outline.' },
  ],
};

const BODY: Readonly<Record<string, string>> = {
  'planning.outline': 'Outline {{topic}} in a {{tone}} tone.',
  'writing.draft': 'Draft {{topic}} from {{outline}}.',
};

const VERSIONS: Readonly<Record<string, number>> = {
  'planning.outline': 7,
  'writing.draft': 3,
};

const template = (
  id: string,
  version = VERSIONS[id] as number,
  status: PromptTemplate['status'] = 'active',
): PromptTemplate => ({
  id,
  version,
  taskType: id,
  status,
  parts: { system: 'You write.', user: BODY[id] as string },
  variables: VARIABLES[id] as PromptTemplate['variables'],
  modelHints: { maxOutputTokens: 512, temperature: 0.2, determinismRequired: false },
  evalSetRef: `evals/${id}`,
  owner: 'content-platform',
  changelog: 'Initial.',
});

function libraryOf(versions: Readonly<Record<string, readonly number[]>>): TemplateLibrary {
  const library = createTemplateLibrary(
    Object.entries(versions).map(([id, numbers]) => ({
      id,
      metadata: {
        title: id,
        description: `The ${id} prompt.`,
        owner: 'content-platform',
        visibility: 'public' as const,
        tags: [],
      },
      // Only the last is active: the library refuses two active versions of one
      // template, because 'latest stable' would otherwise be a coin toss.
      versions: numbers.map((number, index) => ({
        prompt: template(id, number, index === numbers.length - 1 ? 'active' : 'deprecated'),
        semanticVersion: `1.${String(index)}.0`,
        compatibility: { capability: 'chat' as const, providers: null, models: null },
      })),
    })),
  );
  library.seal();
  return library;
}

const LIBRARY = libraryOf({ 'planning.outline': [7], 'writing.draft': [3] });

// ── Blueprint ───────────────────────────────────────────────────────────────

const step = (id: string, next: string | null, templateId: string): WorkflowStepDefinition => ({
  kind: 'prompt',
  id,
  description: `Render ${templateId}.`,
  templateRef: { id: templateId, selector: { kind: 'latest-stable' } },
  bindOutputTo: id === 'outline' ? 'outline' : undefined,
  next,
});

const DEFINITION: ContentWorkflowDefinition = {
  id: 'article.draft',
  metadata: {
    title: 'Draft an article',
    description: 'Outline, then draft.',
    owner: 'content-platform',
    visibility: 'public',
    tags: ['article'],
  },
  versions: [
    {
      version: 2,
      semanticVersion: '1.1.0',
      status: 'active',
      capability: { capability: 'chat', executionMode: 'buffered' },
      entryStepId: 'outline',
      steps: [step('outline', 'draft', 'planning.outline'), step('draft', null, 'writing.draft')],
      changelog: 'Added the draft step.',
    },
  ],
};

const registryOf = (library: TemplateLibrary = LIBRARY) => {
  const registry = createWorkflowRegistry([DEFINITION], { library });
  registry.seal();
  return registry;
};

const REGISTRY = registryOf();

// ── Drafts ──────────────────────────────────────────────────────────────────

const metadata: DraftMetadata = {
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  principalId: 'user-1',
  principalKind: 'user',
  title: 'An article',
  tags: [],
};

const draft = (overrides: Partial<Parameters<typeof newDraft>[0]> = {}): ContentDraft =>
  newDraft({
    draftId: 'draft-1',
    metadata,
    workflowId: 'article.draft',
    workflowVersion: 2,
    workflowRef: 'article.draft@2',
    capability: 'chat',
    templateReferences: [
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
      { templateId: 'writing.draft', templateVersion: 3, promptVersion: 'writing.draft@3' },
    ],
    inputs: { topic: 'multi-tenancy' },
    now: AT,
    ...overrides,
  });

const codesOf = (value: ContentDraft, library: TemplateLibrary = LIBRARY): readonly string[] => {
  const result = validateDraft({
    draft: value,
    workflows: registryOf(library),
    templates: library,
  });
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

// ── The workflow ────────────────────────────────────────────────────────────

describe('validating the workflow', () => {
  it('accepts a draft against a workflow that exists at its pinned version', () => {
    const result = validateDraft({ draft: draft(), workflows: REGISTRY, templates: LIBRARY });
    expect(result.ok).toBe(true);
  });

  it('returns the resolved workflow, so callers do not resolve it again', () => {
    const result = validateDraft({ draft: draft(), workflows: REGISTRY, templates: LIBRARY });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.workflowVersion).toBe('article.draft@2');
    expect(result.templates.map((entry) => entry.id)).toEqual([
      'planning.outline',
      'writing.draft',
    ]);
  });

  it('refuses a workflow that does not exist', () => {
    expect(codesOf(draft({ workflowId: 'article.nothing' }))).toContain('UnknownWorkflow');
  });

  it('refuses a version the registry does not have', () => {
    expect(codesOf(draft({ workflowVersion: 99 }))).toContain('UnknownVersion');
  });

  it('refuses a recorded reference that no longer matches', () => {
    // A pinned reference does not move; one that has is a record that lies.
    expect(codesOf(draft({ workflowRef: 'article.draft@1' }))).toContain('IMMUTABLE_REFERENCE');
  });
});

// ── Templates ───────────────────────────────────────────────────────────────

describe('validating template references', () => {
  it('refuses a draft whose pinned template has been promoted since', () => {
    // The frozen orchestrator resolves templates itself, so an un-refused drift
    // would run a prompt the author never saw.
    const promoted = libraryOf({ 'planning.outline': [7, 8], 'writing.draft': [3] });
    expect(codesOf(draft(), promoted)).toContain('TEMPLATE_DRIFT');
  });

  it('says which reference moved, and to what', () => {
    const promoted = libraryOf({ 'planning.outline': [7, 8], 'writing.draft': [3] });
    const result = validateDraft({
      draft: draft(),
      workflows: registryOf(promoted),
      templates: promoted,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.detail).toMatch(/pinned 'planning\.outline@7'.*'planning\.outline@8'/);
  });

  it('refuses a draft that pinned a different number of templates', () => {
    expect(
      codesOf(
        draft({
          templateReferences: [
            {
              templateId: 'planning.outline',
              templateVersion: 7,
              promptVersion: 'planning.outline@7',
            },
          ],
        }),
      ),
    ).toContain('TEMPLATE_DRIFT');
  });
});

// ── Inputs ──────────────────────────────────────────────────────────────────

describe('which inputs a draft needs', () => {
  it('is every declared variable except the ones a step binds', () => {
    const resolution = resolveWorkflow({
      registry: REGISTRY,
      id: 'article.draft',
      selector: { kind: 'explicit', version: 2 },
    });
    if (resolution.outcome !== 'resolved') throw new Error('expected a resolution');

    expect(requiredInputsFor(resolution.resolved, LIBRARY).map((input) => input.name)).toEqual([
      'topic',
      'tone',
    ]);
  });

  it('never asks for what the workflow is about to produce', () => {
    const resolution = resolveWorkflow({
      registry: REGISTRY,
      id: 'article.draft',
      selector: { kind: 'explicit', version: 2 },
    });
    if (resolution.outcome !== 'resolved') throw new Error('expected a resolution');

    expect(
      requiredInputsFor(resolution.resolved, LIBRARY).map((input) => input.name),
    ).not.toContain('outline');
  });

  it('says which step wants each one', () => {
    const resolution = resolveWorkflow({
      registry: REGISTRY,
      id: 'article.draft',
      selector: { kind: 'explicit', version: 2 },
    });
    if (resolution.outcome !== 'resolved') throw new Error('expected a resolution');

    expect(requiredInputsFor(resolution.resolved, LIBRARY)[0]?.stepId).toBe('outline');
  });
});

describe('validating inputs', () => {
  it('refuses a missing required input', () => {
    expect(codesOf(draft({ inputs: {} }))).toContain('MISSING_INPUT');
  });

  it('refuses an explicit null for a required input', () => {
    expect(codesOf(draft({ inputs: { topic: null } }))).toContain('MISSING_INPUT');
  });

  it('accepts a missing optional input', () => {
    expect(codesOf(draft({ inputs: { topic: 'x' } }))).toEqual([]);
  });

  it('refuses an input no template declares', () => {
    // The runtime refuses a variable no template declared; catching it here is
    // the same rule, applied where it is cheap.
    expect(codesOf(draft({ inputs: { topic: 'x', nonsense: 'y' } }))).toContain('UNKNOWN_INPUT');
  });

  it('accepts a value bound by a step, since a template declares it', () => {
    expect(codesOf(draft({ inputs: { topic: 'x', outline: 'supplied' } }))).toEqual([]);
  });

  it('says nothing about value types, which the prompt compiler owns', () => {
    // A half-typed number is normal mid-edit, and a second copy of the frozen
    // conformance rules could disagree with the one that actually runs.
    expect(codesOf(draft({ inputs: { topic: 42 } }))).toEqual([]);
  });

  it('reports every problem, not the first', () => {
    const result = validateDraft({
      draft: draft({ inputs: { nonsense: 'y' } }),
      workflows: REGISTRY,
      templates: LIBRARY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      'MISSING_INPUT',
      'UNKNOWN_INPUT',
    ]);
  });

  it('names where each problem is', () => {
    const result = validateDraft({
      draft: draft({ inputs: {} }),
      workflows: REGISTRY,
      templates: LIBRARY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.field).toBe('inputs.topic');
  });
});

// ── Revisions ───────────────────────────────────────────────────────────────

describe('validating the revision chain', () => {
  it('accepts a chain that only ever appended', () => {
    let value = draft();
    value = appendRevision({ draft: value, status: 'draft', note: 'Edited.', now: AT });
    value = appendRevision({ draft: value, status: 'ready', note: 'Validated.', now: AT });

    expect(codesOf(value)).toEqual([]);
  });

  it('refuses a chain with a gap', () => {
    // A gap means a revision was dropped, and the history is no longer history.
    const broken = {
      ...draft(),
      revisions: [
        {
          revision: 1,
          status: 'draft' as const,
          inputs: { topic: 'x' },
          title: 't',
          note: 'n',
          createdAt: AT,
        },
        {
          revision: 3,
          status: 'draft' as const,
          inputs: { topic: 'x' },
          title: 't',
          note: 'n',
          createdAt: AT,
        },
      ],
    };

    expect(codesOf(broken)).toContain('OUT_OF_SEQUENCE');
  });

  it('refuses a status move the lifecycle does not allow', () => {
    const broken = {
      ...draft(),
      revisions: [
        {
          revision: 1,
          status: 'draft' as const,
          inputs: { topic: 'x' },
          title: 't',
          note: 'n',
          createdAt: AT,
        },
        {
          revision: 2,
          status: 'submitted' as const,
          inputs: { topic: 'x' },
          title: 't',
          note: 'n',
          createdAt: AT,
        },
      ],
    };

    expect(codesOf(broken)).toContain('ILLEGAL_TRANSITION');
  });

  it('refuses a revision that does not say why it exists', () => {
    const broken = {
      ...draft(),
      revisions: [
        {
          revision: 1,
          status: 'draft' as const,
          inputs: { topic: 'x' },
          title: 't',
          note: '  ',
          createdAt: AT,
        },
      ],
    };

    expect(codesOf(broken)).toContain('MISSING');
  });

  it('refuses a status nothing recognises', () => {
    const broken = {
      ...draft(),
      revisions: [
        {
          revision: 1,
          status: 'archived' as never,
          inputs: { topic: 'x' },
          title: 't',
          note: 'n',
          createdAt: AT,
        },
      ],
    };

    expect(codesOf(broken)).toContain('UNKNOWN_STATUS');
  });
});
