import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import { createWorkflowRegistry, type ContentWorkflowDefinition } from '../blueprints/registry.js';
import type { WorkflowStepDefinition } from '../blueprints/steps.js';
import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import type { PromptTemplate } from '../prompts/template.js';
import { createTemplateLibrary, type TemplateLibrary } from '../templates/library.js';
import {
  compileDraft,
  DRAFT_COMPILATION_CODES,
  isDraftCompilationCode,
  type CompileDraftOptions,
} from './compile.js';
import { appendRevision, newDraft, type ContentDraft, type DraftMetadata } from './draft.js';

const AT = '2026-07-31T12:00:00.000Z';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

// ── Fixtures ────────────────────────────────────────────────────────────────

const VARIABLES: Readonly<Record<string, PromptTemplate['variables']>> = {
  'planning.outline': [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
    { name: 'depth', type: 'number', required: false, description: 'How many sections.' },
  ],
  'writing.draft': [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
    { name: 'outline', type: 'string', required: false, description: 'The bound outline.' },
  ],
};

const BODY: Readonly<Record<string, string>> = {
  'planning.outline': 'Outline {{topic}} in {{depth}} sections.',
  'writing.draft': 'Draft {{topic}} from {{outline}}.',
};

const template = (id: string, version: number): PromptTemplate => ({
  id,
  version,
  taskType: id,
  status: 'active',
  parts: { system: 'You write.', user: BODY[id] as string },
  variables: VARIABLES[id] as PromptTemplate['variables'],
  modelHints: { maxOutputTokens: 512, temperature: 0.2, determinismRequired: false },
  evalSetRef: `evals/${id}`,
  owner: 'content-platform',
  changelog: 'Initial.',
});

const LIBRARY: TemplateLibrary = createTemplateLibrary(
  [
    { id: 'planning.outline', version: 7 },
    { id: 'writing.draft', version: 3 },
  ].map((entry) => ({
    id: entry.id,
    metadata: {
      title: entry.id,
      description: `The ${entry.id} prompt.`,
      owner: 'content-platform',
      visibility: 'public' as const,
      tags: [],
    },
    versions: [
      {
        prompt: template(entry.id, entry.version),
        semanticVersion: '1.0.0',
        compatibility: { capability: 'chat' as const, providers: null, models: null },
      },
    ],
  })),
);
LIBRARY.seal();

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

const REGISTRY = createWorkflowRegistry([DEFINITION], { library: LIBRARY });
REGISTRY.seal();

const metadata: DraftMetadata = {
  organizationId: ORG,
  workspaceId: WS,
  principalId: 'user-1',
  principalKind: 'user',
  title: 'An article',
  tags: [],
};

const principal: Principal = {
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: ORG,
  workspaceId: WS,
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: new Date(AT),
  mfaSatisfied: true,
  sessionId: null,
};

const organization: AdmissionOrganization = { organizationId: ORG, status: 'active' };
const workspace: AdmissionWorkspace = {
  workspaceId: WS,
  organizationId: ORG,
  status: 'active',
};

function draftOf(
  inputs: Readonly<Record<string, unknown>> = { topic: 'multi-tenancy' },
  ready = true,
): ContentDraft {
  const base = newDraft({
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
    inputs,
    now: AT,
  });

  return ready
    ? appendRevision({ draft: base, status: 'ready', note: 'Validated.', now: AT })
    : base;
}

const options = (overrides: Partial<CompileDraftOptions> = {}): CompileDraftOptions => ({
  draft: draftOf(),
  workflows: REGISTRY,
  templates: LIBRARY,
  principal,
  organization,
  workspace,
  correlationId: CORRELATION,
  idempotencyKey: 'idem-1',
  model: 'gpt-4o',
  timeoutMs: 30_000,
  ...overrides,
});

// ── Compiling ───────────────────────────────────────────────────────────────

describe('compiling a draft', () => {
  it('produces a run request', () => {
    const result = compileDraft(options());

    expect(result.outcome).toBe('compiled');
    if (result.outcome !== 'compiled') return;
    expect(result.request.workflowId).toBe('article.draft');
  });

  it('pins the workflow version the draft recorded', () => {
    // A request resolving `latest-stable` would run a workflow the author never
    // saw; the whole point of a pin is that it does not move.
    const result = compileDraft(options());

    expect(result.outcome).toBe('compiled');
    if (result.outcome !== 'compiled') return;
    expect(result.request.selector).toEqual({ kind: 'explicit', version: 2 });
  });

  it('carries the draft inputs as the run variables', () => {
    const result = compileDraft(options());

    if (result.outcome !== 'compiled') return;
    expect(result.request.variables).toEqual({ topic: 'multi-tenancy' });
  });

  it('carries the caller identity, not the draft author', () => {
    // A draft stores identity, never authority. The principal on a run is the
    // one resolved for THIS request.
    const result = compileDraft(options());

    if (result.outcome !== 'compiled') return;
    expect(result.request.metadata.principal).toBe(principal);
    expect(result.request.metadata.correlationId).toBe(CORRELATION);
    expect(result.request.metadata.idempotencyKey).toBe('idem-1');
  });

  it('carries the capability the workflow declares', () => {
    const result = compileDraft(options());

    if (result.outcome !== 'compiled') return;
    expect(result.request.capability).toBe('chat');
  });

  it('supplies every template the run catalogue will need', () => {
    const result = compileDraft(options());

    if (result.outcome !== 'compiled') return;
    expect(result.request.promptTemplates.map((entry) => entry.id)).toEqual([
      'planning.outline',
      'writing.draft',
    ]);
  });

  it('carries the model and timeout the caller asked for', () => {
    const result = compileDraft(options({ model: 'claude-x', timeoutMs: 5_000 }));

    if (result.outcome !== 'compiled') return;
    expect(result.request.model).toBe('claude-x');
    expect(result.request.timeoutMs).toBe(5_000);
  });

  it('passes an optional run deadline through', () => {
    const result = compileDraft(options({ runTimeoutMs: 60_000 }));

    if (result.outcome !== 'compiled') return;
    expect(result.request.runTimeoutMs).toBe(60_000);
  });

  it('omits an optional field the caller did not set', () => {
    const result = compileDraft(options());

    if (result.outcome !== 'compiled') return;
    expect('runTimeoutMs' in result.request).toBe(false);
    expect('jobId' in result.request).toBe(false);
  });

  it('freezes what it returns', () => {
    const result = compileDraft(options());

    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome !== 'compiled') return;
    expect(Object.isFrozen(result.request)).toBe(true);
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe('refusing to compile', () => {
  it('refuses a draft that is not ready', () => {
    const result = compileDraft(options({ draft: draftOf({ topic: 'x' }, false) }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('NotReady');
  });

  it('refuses a draft from another workspace', () => {
    // The run would carry the caller's tenancy and the draft's content, and the
    // record of who ran what would be wrong.
    const other: AdmissionWorkspace = {
      workspaceId: '018f7a1e-0000-7000-8000-0000000000ee',
      organizationId: ORG,
      status: 'active',
    };
    const result = compileDraft(options({ workspace: other }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('TenancyMismatch');
  });

  it('refuses a draft from another organization', () => {
    const other: AdmissionOrganization = {
      organizationId: '018f7a1e-0000-7000-8000-0000000000ff',
      status: 'active',
    };
    const result = compileDraft(options({ organization: other }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('TenancyMismatch');
  });

  it('checks tenancy before anything else', () => {
    // A draft from another workspace is refused on tenancy, never on why its
    // contents happen to be wrong.
    const other: AdmissionWorkspace = {
      workspaceId: '018f7a1e-0000-7000-8000-0000000000ee',
      organizationId: ORG,
      status: 'active',
    };
    const result = compileDraft(
      options({ workspace: other, draft: draftOf({ topic: 'x' }, false) }),
    );

    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('TenancyMismatch');
  });

  it('re-validates against the registry as it stands', () => {
    // A draft became READY at a moment. A workflow retired since would make that
    // claim stale, and the run would be the thing that discovered it.
    const withoutIt = createWorkflowRegistry([{ ...DEFINITION, id: 'article.other' }]);
    withoutIt.seal();
    const result = compileDraft(options({ workflows: withoutIt }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('DraftInvalid');
  });

  it('refuses inputs the prompt compiler will not accept', () => {
    // Value conformance is the frozen compiler's rule, applied here — the last
    // moment before money is spent — rather than restated.
    const result = compileDraft(options({ draft: draftOf({ topic: 'x', depth: 'three' }) }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InputsInvalid');
    expect(result.reason).toMatch(/depth/);
  });

  it('accepts inputs the prompt compiler does accept', () => {
    expect(compileDraft(options({ draft: draftOf({ topic: 'x', depth: 3 }) })).outcome).toBe(
      'compiled',
    );
  });

  it('does not mistake a step-bound name for a missing input', () => {
    // `outline` is bound by the step before it. Supplying an empty string is
    // exactly what the runtime will have there for an optional slot.
    expect(compileDraft(options()).outcome).toBe('compiled');
  });

  it('carries every issue on a refusal', () => {
    const result = compileDraft(options({ draft: draftOf({}) }));

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('the compilation taxonomy', () => {
  it('names what compilation can refuse', () => {
    expect([...DRAFT_COMPILATION_CODES]).toEqual([
      'DraftInvalid',
      'NotReady',
      'TenancyMismatch',
      'InputsInvalid',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    expect(isDraftCompilationCode('NotReady')).toBe(true);
    expect(isDraftCompilationCode('notReady')).toBe(false);
    expect(isDraftCompilationCode('Exploded')).toBe(false);
  });
});
