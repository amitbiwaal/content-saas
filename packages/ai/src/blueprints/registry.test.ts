import { describe, expect, it } from 'vitest';

import type { PromptTemplate } from '../prompts/template.js';
import { createTemplateLibrary } from '../templates/library.js';
import {
  createWorkflowRegistry,
  describeWorkflowVersion,
  isWorkflowRegistryError,
  WorkflowRegistryError,
  type ContentWorkflowDefinition,
} from './registry.js';
import { isLinear, resolveWorkflow, toRuntimeDefinition } from './resolve.js';
import type { WorkflowMetadata, WorkflowStepDefinition } from './steps.js';

const template = (id: string): PromptTemplate => ({
  id,
  version: 4,
  taskType: id,
  status: 'active',
  parts: { system: 'S', user: 'U {{topic}}' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 512, temperature: 0.2, determinismRequired: false },
  evalSetRef: `evals/${id}`,
  owner: 'content-platform',
  changelog: 'Initial.',
});

/** `review.scores` is `text`, so a text workflow has something to reference. */
const CAPABILITY_OF: Readonly<Record<string, 'chat' | 'text'>> = {
  'planning.outline': 'chat',
  'writing.draft': 'chat',
  'review.scores': 'text',
};

const LIBRARY = createTemplateLibrary(
  Object.keys(CAPABILITY_OF).map((id) => ({
    id,
    metadata: {
      title: id,
      description: `The ${id} prompt.`,
      owner: 'content-platform',
      visibility: 'public' as const,
      tags: [],
    },
    versions: [
      {
        prompt: template(id),
        semanticVersion: '1.0.0',
        compatibility: {
          capability: CAPABILITY_OF[id] as 'chat' | 'text',
          providers: null,
          models: null,
        },
      },
    ],
  })),
);
LIBRARY.seal();

const metadata = (overrides: Partial<WorkflowMetadata> = {}): WorkflowMetadata => ({
  title: 'Draft an article',
  description: 'Outline, then draft.',
  owner: 'content-platform',
  visibility: 'public',
  tags: ['article'],
  ...overrides,
});

const step = (id: string, next: string | null, templateId: string): WorkflowStepDefinition => ({
  kind: 'prompt',
  id,
  description: `Render ${templateId}.`,
  templateRef: { id: templateId, selector: { kind: 'latest-stable' } },
  bindOutputTo: id.replace(/-/g, '_'),
  next,
});

const STEPS: readonly WorkflowStepDefinition[] = [
  step('outline', 'draft', 'planning.outline'),
  step('draft', null, 'writing.draft'),
];

const version = (
  overrides: Partial<ContentWorkflowDefinition['versions'][number]> = {},
): ContentWorkflowDefinition['versions'][number] => ({
  version: 1,
  semanticVersion: '1.0.0',
  status: 'active',
  capability: { capability: 'chat', executionMode: 'buffered' },
  entryStepId: 'outline',
  steps: STEPS,
  changelog: 'Initial version.',
  ...overrides,
});

const definition = (
  overrides: Partial<ContentWorkflowDefinition> = {},
): ContentWorkflowDefinition => ({
  id: 'article.draft',
  metadata: metadata(),
  versions: [version()],
  ...overrides,
});

const registryOf = (...definitions: ContentWorkflowDefinition[]) =>
  createWorkflowRegistry(definitions.length === 0 ? [definition()] : definitions, {
    library: LIBRARY,
  });

describe('registering a workflow', () => {
  it('holds its identity, metadata and versions', () => {
    const workflow = registryOf().get('article.draft');

    expect(workflow.id).toBe('article.draft');
    expect(workflow.metadata.title).toBe('Draft an article');
    expect(workflow.versions).toHaveLength(1);
    expect(workflow.versions[0]?.steps).toHaveLength(2);
  });

  it('validates the whole graph at registration', () => {
    // A blueprint that cannot be walked is refused when it is cheap to fix.
    expect(() =>
      registryOf(
        definition({
          versions: [version({ steps: [step('outline', 'ghost', 'planning.outline')] })],
        }),
      ),
    ).toThrow(/not a runnable blueprint/);
  });

  it('carries every blueprint issue on the error', () => {
    try {
      registryOf(
        definition({
          versions: [version({ steps: [step('outline', 'outline', 'planning.outline')] })],
        }),
      );
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(isWorkflowRegistryError(failure)).toBe(true);
      if (!isWorkflowRegistryError(failure)) return;
      expect(failure.code).toBe('InvalidBlueprint');
      expect(failure.issues.map((issue) => issue.code)).toContain('CYCLE');
    }
  });

  it('rejects a template reference the library does not have', () => {
    expect(() =>
      registryOf(
        definition({ versions: [version({ steps: [step('outline', null, 'nothing.here')] })] }),
      ),
    ).toThrow(/UnknownTemplate/);
  });

  it('requires a dot.case id', () => {
    expect(() => registryOf(definition({ id: 'article draft' }))).toThrow(/dot\.case/);
  });

  it('requires a changelog on every version', () => {
    // A version nobody can explain is one nobody can roll back with confidence.
    expect(() => registryOf(definition({ versions: [version({ changelog: '  ' })] }))).toThrow(
      /no changelog/,
    );
  });

  it('normalises tags', () => {
    const workflow = registryOf(
      definition({ metadata: metadata({ tags: ['Article', ' article ', 'DRAFT'] }) }),
    ).get('article.draft');
    expect(workflow.metadata.tags).toEqual(['article', 'draft']);
  });

  it('rejects a duplicate workflow id', () => {
    expect(() => registryOf(definition(), definition())).toThrow(/registered twice/);
  });

  it('rejects a workflow with no versions', () => {
    expect(() => registryOf(definition({ versions: [] }))).toThrow(/no versions/);
  });
});

describe('version rules', () => {
  it('requires versions to be declared ascending', () => {
    expect(() =>
      registryOf(
        definition({
          versions: [
            version({ version: 2, semanticVersion: '2.0.0' }),
            version({ version: 1, status: 'deprecated' }),
          ],
        }),
      ),
    ).toThrow(/monotonic/);
  });

  it('rejects a duplicate version number', () => {
    expect(() =>
      registryOf(
        definition({
          versions: [version({ status: 'deprecated' }), version({ semanticVersion: '1.0.1' })],
        }),
      ),
    ).toThrow(/twice/);
  });

  it('rejects two active versions', () => {
    expect(() =>
      registryOf(
        definition({
          versions: [version(), version({ version: 2, semanticVersion: '2.0.0' })],
        }),
      ),
    ).toThrow(/only one may be active/);
  });

  it('rejects a semantic version that is not one', () => {
    expect(() =>
      registryOf(definition({ versions: [version({ semanticVersion: '^1.0' })] })),
    ).toThrow(/major\.minor\.patch/);
  });

  it('rejects a version number that is not a positive integer', () => {
    for (const value of [0, -1, 1.5]) {
      expect(() => {
        registryOf(definition({ versions: [version({ version: value })] }));
      }, String(value)).toThrow(WorkflowRegistryError);
    }
  });
});

describe('lookup', () => {
  const registry = registryOf(
    definition({
      versions: [
        version({ version: 1, status: 'deprecated' }),
        version({ version: 2, semanticVersion: '1.2.0', status: 'active' }),
        version({ version: 3, semanticVersion: '2.0.0', status: 'draft' }),
      ],
    }),
    definition({
      id: 'article.review',
      metadata: metadata({ title: 'Review', visibility: 'internal' }),
      versions: [
        version({
          capability: { capability: 'text', executionMode: 'buffered' },
          steps: [step('outline', null, 'review.scores')],
        }),
      ],
    }),
  );

  it('finds by id', () => {
    expect(registry.find('article.draft')?.id).toBe('article.draft');
    expect(registry.find('nothing')).toBeNull();
    expect(registry.has('article.review')).toBe(true);
  });

  it('throws for an unknown id rather than substituting', () => {
    expect(() => registry.get('nothing')).toThrow(/No workflow/);
  });

  it('finds by capability', () => {
    expect(registry.byCapability('chat').map((w) => w.id)).toEqual(['article.draft']);
    expect(registry.byCapability('text').map((w) => w.id)).toEqual(['article.review']);
    expect(registry.byCapability('audio')).toEqual([]);
  });

  it('finds one version by its monotonic number', () => {
    expect(registry.version('article.draft', 2)?.status).toBe('active');
    expect(registry.version('article.draft', 9)).toBeNull();
    expect(registry.version('nothing', 1)).toBeNull();
  });

  it('finds the single active version as latest stable', () => {
    expect(registry.latestStable('article.draft')?.version).toBe(2);
    expect(registry.latestStable('nothing')).toBeNull();
  });

  it('lists in registration order', () => {
    expect(registry.list().map((w) => w.id)).toEqual(['article.draft', 'article.review']);
  });

  it('describes a version for an operator', () => {
    const version1 = registry.version('article.draft', 1);
    if (version1 === null) throw new Error('expected a version');
    expect(describeWorkflowVersion('article.draft', version1)).toBe(
      'article.draft@1 (1.0.0, deprecated)',
    );
  });
});

describe('sealing and immutability', () => {
  it('refuses a registration after sealing', () => {
    // A run pins its definition at start; a blueprint that changed mid-process
    // would alter runs already in flight.
    const registry = registryOf();
    registry.seal();
    expect(() => {
      registry.register(definition({ id: 'other.workflow' }));
    }).toThrow(/sealed/);
  });

  it('is idempotent', () => {
    const registry = registryOf();
    registry.seal();
    expect(() => {
      registry.seal();
    }).not.toThrow();
    expect(registry.sealed).toBe(true);
  });

  it('refuses to seal an empty registry', () => {
    expect(() => {
      createWorkflowRegistry([]).seal();
    }).toThrow(/produce nothing/);
  });

  it('freezes what it holds', () => {
    const workflow = registryOf().get('article.draft');

    expect(Object.isFrozen(workflow)).toBe(true);
    expect(Object.isFrozen(workflow.metadata)).toBe(true);
    expect(Object.isFrozen(workflow.versions)).toBe(true);
    expect(Object.isFrozen(workflow.versions[0])).toBe(true);
    expect(Object.isFrozen(workflow.versions[0]?.steps)).toBe(true);
    expect(Object.isFrozen(workflow.versions[0]?.steps[0])).toBe(true);
  });

  it('refuses a write rather than accepting one a cast made legal', () => {
    const workflow = registryOf().get('article.draft');
    expect(() => {
      (workflow as unknown as { id: string }).id = 'other';
    }).toThrow(TypeError);
    expect(() => {
      (workflow.versions as unknown as { push: (v: unknown) => void }).push({});
    }).toThrow(TypeError);
  });
});

describe('resolution', () => {
  const registry = registryOf(
    definition({
      versions: [
        version({ version: 1, status: 'deprecated' }),
        version({ version: 2, semanticVersion: '1.2.0', status: 'active' }),
        version({ version: 3, semanticVersion: '2.0.0', status: 'draft' }),
      ],
    }),
    definition({
      id: 'article.review',
      metadata: metadata({ title: 'Review', visibility: 'internal' }),
      versions: [version()],
    }),
  );

  const resolve = (overrides: Partial<Parameters<typeof resolveWorkflow>[0]> = {}) =>
    resolveWorkflow({
      registry,
      id: 'article.draft',
      selector: { kind: 'latest-stable' },
      ...overrides,
    });

  const versionOf = (result: ReturnType<typeof resolve>): number => {
    if (result.outcome !== 'resolved') throw new Error(`expected a resolution, got ${result.code}`);
    return result.resolved.version.version;
  };

  it('refuses an unknown workflow', () => {
    expect(resolve({ id: 'nothing' })).toMatchObject({ code: 'UnknownWorkflow' });
  });

  it('resolves the single active version and its anchor', () => {
    const result = resolve();
    if (result.outcome !== 'resolved') throw new Error('expected a resolution');
    expect(result.resolved.version.version).toBe(2);
    expect(result.resolved.workflowVersion).toBe('article.draft@2');
    expect(result.resolved.selector).toBe('latest-stable');
  });

  it('resolves an explicit version, including a deprecated one', () => {
    expect(versionOf(resolve({ selector: { kind: 'explicit', version: 1 } }))).toBe(1);
  });

  it('refuses an explicit version that does not exist', () => {
    expect(resolve({ selector: { kind: 'explicit', version: 9 } })).toMatchObject({
      code: 'UnknownVersion',
    });
  });

  it('refuses a deprecated version reached implicitly', () => {
    const deprecatedMajor = registryOf(
      definition({
        versions: [
          version({ version: 1, status: 'deprecated' }),
          version({ version: 2, semanticVersion: '2.0.0', status: 'active' }),
        ],
      }),
    );
    expect(
      resolveWorkflow({
        registry: deprecatedMajor,
        id: 'article.draft',
        selector: { kind: 'latest-compatible', compatibleWith: '1.0.0' },
      }),
    ).toMatchObject({ code: 'WorkflowDeprecated' });
  });

  it('never crosses a major on latest-compatible', () => {
    expect(
      versionOf(resolve({ selector: { kind: 'latest-compatible', compatibleWith: '1.0.0' } })),
    ).toBe(2);
    expect(
      resolve({ selector: { kind: 'latest-compatible', compatibleWith: '3.0.0' } }),
    ).toMatchObject({ code: 'NoCompatibleVersion' });
  });

  it('refuses an ambiguous version rather than guessing', () => {
    expect(
      resolve({ selector: { kind: 'latest-compatible', compatibleWith: '^1.0' } }),
    ).toMatchObject({ code: 'AmbiguousVersion' });
  });

  it('refuses when nothing is active', () => {
    const drafts = registryOf(definition({ versions: [version({ status: 'draft' })] }));
    expect(
      resolveWorkflow({
        registry: drafts,
        id: 'article.draft',
        selector: { kind: 'latest-stable' },
      }),
    ).toMatchObject({ code: 'NoStableVersion' });
  });

  it('refuses an internal workflow for a public caller', () => {
    expect(resolve({ id: 'article.review', visibility: 'public' })).toMatchObject({
      code: 'WorkflowNotVisible',
    });
  });

  it('refuses a capability the version does not deliver', () => {
    expect(resolve({ capability: 'embedding' })).toMatchObject({
      code: 'CapabilityIncompatible',
    });
  });

  it('is deterministic', () => {
    expect(resolve({ capability: 'chat' })).toEqual(resolve({ capability: 'chat' }));
  });

  it('freezes what it returns', () => {
    const result = resolve();
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('the seam into the frozen runtime', () => {
  const registry = registryOf();
  const resolved = (() => {
    const result = resolveWorkflow({
      registry,
      id: 'article.draft',
      selector: { kind: 'latest-stable' },
    });
    if (result.outcome !== 'resolved') throw new Error('expected a resolution');
    return result.resolved;
  })();

  it('recognises a straight line', () => {
    expect(isLinear(resolved.version)).toBe(true);
  });

  it('does not call a graph linear', () => {
    const graph = registryOf(
      definition({
        versions: [
          version({
            steps: [
              step('outline', 'fork', 'planning.outline'),
              {
                kind: 'branch',
                id: 'fork',
                description: 'Fork.',
                on: 'outline',
                cases: [{ when: 'a', next: 'draft' }],
                otherwise: null,
              },
              step('draft', null, 'writing.draft'),
            ],
          }),
        ],
      }),
    );
    const version2 = graph.version('article.draft', 1);
    if (version2 === null) throw new Error('expected a version');
    expect(isLinear(version2)).toBe(false);
  });

  it('produces a definition with the template versions RESOLVED', () => {
    // The runtime receives a pinned integer rather than a selector it has no
    // way to evaluate.
    const definitionForRuntime = toRuntimeDefinition({
      resolved,
      library: LIBRARY,
      timeoutMs: 30_000,
      model: 'gpt-4o',
    });

    expect(definitionForRuntime.id).toBe('article.draft');
    expect(definitionForRuntime.version).toBe(1);
    expect(definitionForRuntime.steps.map((s) => s.templateRef)).toEqual([
      { id: 'planning.outline', version: 4 },
      { id: 'writing.draft', version: 4 },
    ]);
  });

  it('takes the model from the CALLER, because a blueprint never names one', () => {
    const compiled = toRuntimeDefinition({
      resolved,
      library: LIBRARY,
      timeoutMs: 15_000,
      model: 'claude-sonnet',
    });
    expect(compiled.steps.every((s) => s.model === 'claude-sonnet')).toBe(true);
    expect(compiled.steps.every((s) => s.timeoutMs === 15_000)).toBe(true);
    expect(JSON.stringify(resolved.version)).not.toContain('claude-sonnet');
  });

  it('refuses a graph rather than flattening it', () => {
    // A flattened branch is a workflow that quietly does the wrong thing on the
    // path nobody tested.
    const graph = registryOf(
      definition({
        versions: [
          version({
            steps: [
              step('outline', 'fork', 'planning.outline'),
              {
                kind: 'branch',
                id: 'fork',
                description: 'Fork.',
                on: 'outline',
                cases: [{ when: 'a', next: 'draft' }],
                otherwise: null,
              },
              step('draft', null, 'writing.draft'),
            ],
          }),
        ],
      }),
    );
    const result = resolveWorkflow({
      registry: graph,
      id: 'article.draft',
      selector: { kind: 'latest-stable' },
    });
    if (result.outcome !== 'resolved') throw new Error('expected a resolution');

    expect(() =>
      toRuntimeDefinition({
        resolved: result.resolved,
        library: LIBRARY,
        timeoutMs: 30_000,
        model: 'gpt-4o',
      }),
    ).toThrow(/single linear sequence/);
  });

  it('refuses a step kind the runtime cannot execute rather than dropping it', () => {
    // Silently omitting a validation step would produce a run that looks
    // complete and skipped its checks.
    const withValidate = registryOf(
      definition({
        versions: [
          version({
            steps: [
              step('outline', 'check', 'planning.outline'),
              {
                kind: 'validate',
                id: 'check',
                description: 'Schema check.',
                validator: 'outline-schema',
                subject: 'outline',
                next: null,
                onFailure: null,
              },
            ],
          }),
        ],
      }),
    );
    const result = resolveWorkflow({
      registry: withValidate,
      id: 'article.draft',
      selector: { kind: 'latest-stable' },
    });
    if (result.outcome !== 'resolved') throw new Error('expected a resolution');

    expect(() =>
      toRuntimeDefinition({
        resolved: result.resolved,
        library: LIBRARY,
        timeoutMs: 30_000,
        model: 'gpt-4o',
      }),
    ).toThrow(/prompt steps only/);
  });

  it('is deterministic', () => {
    const once = toRuntimeDefinition({ resolved, library: LIBRARY, timeoutMs: 1, model: 'm' });
    const twice = toRuntimeDefinition({ resolved, library: LIBRARY, timeoutMs: 1, model: 'm' });
    expect(once).toEqual(twice);
  });
});
