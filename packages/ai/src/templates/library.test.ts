import { describe, expect, it } from 'vitest';

import type { PromptTemplate } from '../prompts/template.js';
import {
  bySemanticVersion,
  createTemplateLibrary,
  describeVersion,
  isTemplateLibraryError,
  newestVersion,
  promptVersionStringOf,
  TemplateLibraryError,
  type TemplateDefinition,
} from './library.js';
import type { TemplateCapability, TemplateMetadata } from './metadata.js';

const prompt = (overrides: Partial<PromptTemplate> = {}): PromptTemplate => ({
  id: 'planning.outline',
  version: 1,
  taskType: 'planning.outline',
  status: 'active',
  parts: { system: 'You write outlines.', user: 'Write an outline about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
  ...overrides,
});

const metadata = (overrides: Partial<TemplateMetadata> = {}): TemplateMetadata => ({
  title: 'Article outline',
  description: 'Produces a structured outline for an article.',
  owner: 'content-platform',
  visibility: 'public',
  tags: ['planning', 'outline'],
  ...overrides,
});

const compatibility = (overrides: Partial<TemplateCapability> = {}): TemplateCapability => ({
  capability: 'chat',
  providers: null,
  models: null,
  ...overrides,
});

const definition = (overrides: Partial<TemplateDefinition> = {}): TemplateDefinition => ({
  id: 'planning.outline',
  metadata: metadata(),
  versions: [{ prompt: prompt(), semanticVersion: '1.0.0', compatibility: compatibility() }],
  ...overrides,
});

describe('registering a template', () => {
  it('holds its identity, metadata and versions', () => {
    const library = createTemplateLibrary([definition()]);
    const template = library.get('planning.outline');

    expect(template.id).toBe('planning.outline');
    expect(template.metadata.title).toBe('Article outline');
    expect(template.versions).toHaveLength(1);
    expect(template.versions[0]?.prompt.version).toBe(1);
  });

  it('normalises tags, so a search is a set membership test', () => {
    const library = createTemplateLibrary([
      definition({ metadata: metadata({ tags: ['Outline', ' outline ', 'PLANNING', ''] }) }),
    ]);
    expect(library.get('planning.outline').metadata.tags).toEqual(['outline', 'planning']);
  });

  it('validates a version through the pipeline OWN validator', () => {
    // A library that re-checked template shape would eventually disagree with
    // the compiler that has to render it.
    expect(() =>
      createTemplateLibrary([
        definition({
          versions: [
            {
              prompt: prompt({ parts: { system: '', user: 'x' } }),
              semanticVersion: '1.0.0',
              compatibility: compatibility(),
            },
          ],
        }),
      ]),
    ).toThrow(/not renderable/);
  });

  it('refuses a version whose prompt belongs to another template', () => {
    // A pinned reference would resolve to the wrong artifact.
    expect(() =>
      createTemplateLibrary([
        definition({
          versions: [
            {
              prompt: prompt({ id: 'writing.draft' }),
              semanticVersion: '1.0.0',
              compatibility: compatibility(),
            },
          ],
        }),
      ]),
    ).toThrow(/wrong artifact/);
  });

  it('refuses a template with no versions', () => {
    expect(() => createTemplateLibrary([definition({ versions: [] })])).toThrow(/no versions/);
  });

  it('refuses a duplicate template id', () => {
    expect(() => createTemplateLibrary([definition(), definition()])).toThrow(/registered twice/);
  });
});

describe('version rules', () => {
  const withVersions = (
    entries: readonly { version: number; status: PromptTemplate['status']; semver: string }[],
  ): TemplateDefinition =>
    definition({
      versions: entries.map((entry) => ({
        prompt: prompt({ version: entry.version, status: entry.status }),
        semanticVersion: entry.semver,
        compatibility: compatibility(),
      })),
    });

  it('requires versions to be declared ascending', () => {
    // Out of order, "the latest" would depend on how the list was written.
    expect(() =>
      createTemplateLibrary([
        withVersions([
          { version: 2, status: 'active', semver: '2.0.0' },
          { version: 1, status: 'deprecated', semver: '1.0.0' },
        ]),
      ]),
    ).toThrow(/monotonic/);
  });

  it('refuses a duplicate version number', () => {
    expect(() =>
      createTemplateLibrary([
        withVersions([
          { version: 1, status: 'deprecated', semver: '1.0.0' },
          { version: 1, status: 'active', semver: '1.0.1' },
        ]),
      ]),
    ).toThrow(/twice/);
  });

  it('refuses two active versions', () => {
    // "Latest stable" would be a coin toss that lands differently per instance.
    expect(() =>
      createTemplateLibrary([
        withVersions([
          { version: 1, status: 'active', semver: '1.0.0' },
          { version: 2, status: 'active', semver: '2.0.0' },
        ]),
      ]),
    ).toThrow(/only one may be active/);
  });

  it('allows drafts and deprecations alongside one active version', () => {
    expect(() =>
      createTemplateLibrary([
        withVersions([
          { version: 1, status: 'deprecated', semver: '1.0.0' },
          { version: 2, status: 'active', semver: '2.0.0' },
          { version: 3, status: 'draft', semver: '3.0.0' },
        ]),
      ]),
    ).not.toThrow();
  });

  it('refuses a semantic version that is not one', () => {
    for (const semver of ['1', '1.0', 'v1.0.0', '^2.1.0', '1.0.0-beta', '01.0.0']) {
      expect(() => {
        createTemplateLibrary([withVersions([{ version: 1, status: 'active', semver }])]);
      }, semver).toThrow(/major\.minor\.patch/);
    }
  });
});

describe('metadata and compatibility validation', () => {
  it('refuses missing metadata', () => {
    for (const field of ['title', 'description', 'owner'] as const) {
      expect(() => {
        createTemplateLibrary([definition({ metadata: metadata({ [field]: '  ' }) })]);
      }, field).toThrow(TemplateLibraryError);
    }
  });

  it('refuses an unknown visibility', () => {
    expect(() =>
      createTemplateLibrary([
        definition({
          metadata: metadata({ visibility: 'secret' as TemplateMetadata['visibility'] }),
        }),
      ]),
    ).toThrow(/public, internal/);
  });

  it('refuses a capability outside the contract vocabulary', () => {
    expect(() =>
      createTemplateLibrary([
        definition({
          versions: [
            {
              prompt: prompt(),
              semanticVersion: '1.0.0',
              compatibility: compatibility({
                capability: 'telepathy' as TemplateCapability['capability'],
              }),
            },
          ],
        }),
      ]),
    ).toThrow(/not one of/);
  });

  it('refuses an empty compatibility list, which would mean nothing can run it', () => {
    // `null` is how "any" is said; `[]` means "none" and is always a mistake.
    for (const field of ['providers', 'models'] as const) {
      expect(() => {
        createTemplateLibrary([
          definition({
            versions: [
              {
                prompt: prompt(),
                semanticVersion: '1.0.0',
                compatibility: compatibility({ [field]: [] }),
              },
            ],
          }),
        ]);
      }, field).toThrow(/use null for "any"/);
    }
  });

  it('accepts null as unrestricted', () => {
    const library = createTemplateLibrary([definition()]);
    expect(library.get('planning.outline').versions[0]?.compatibility.providers).toBeNull();
  });
});

describe('lookup', () => {
  const library = createTemplateLibrary([
    definition(),
    definition({
      id: 'writing.draft',
      metadata: metadata({ title: 'Draft', visibility: 'internal' }),
      versions: [
        {
          prompt: prompt({ id: 'writing.draft', version: 3, status: 'active' }),
          semanticVersion: '2.0.0',
          compatibility: compatibility({ capability: 'text' }),
        },
      ],
    }),
  ]);

  it('finds by id', () => {
    expect(library.find('planning.outline')?.id).toBe('planning.outline');
    expect(library.find('nothing')).toBeNull();
    expect(library.has('writing.draft')).toBe(true);
  });

  it('throws for an unknown id rather than returning a substitute', () => {
    // "There is no fallback prompt, ever."
    expect(() => library.get('nothing')).toThrow(/No template/);
  });

  it('finds by capability', () => {
    expect(library.byCapability('chat').map((t) => t.id)).toEqual(['planning.outline']);
    expect(library.byCapability('text').map((t) => t.id)).toEqual(['writing.draft']);
    expect(library.byCapability('audio')).toEqual([]);
  });

  it('finds one version by its monotonic number', () => {
    expect(library.version('writing.draft', 3)?.prompt.status).toBe('active');
    expect(library.version('writing.draft', 9)).toBeNull();
    expect(library.version('nothing', 1)).toBeNull();
  });

  it('finds the single active version as latest stable', () => {
    expect(library.latestStable('planning.outline')?.prompt.version).toBe(1);
    expect(library.latestStable('nothing')).toBeNull();
  });

  it('reports null when nothing is active', () => {
    const drafts = createTemplateLibrary([
      definition({
        versions: [
          {
            prompt: prompt({ status: 'draft' }),
            semanticVersion: '1.0.0',
            compatibility: compatibility(),
          },
        ],
      }),
    ]);
    expect(drafts.latestStable('planning.outline')).toBeNull();
  });

  it('lists in registration order', () => {
    expect(library.list().map((t) => t.id)).toEqual(['planning.outline', 'writing.draft']);
  });
});

describe('sealing and immutability', () => {
  it('refuses a registration after sealing', () => {
    // An active prompt that changed mid-process would alter the provenance of
    // calls already in flight.
    const library = createTemplateLibrary([definition()]);
    library.seal();
    expect(() => {
      library.register(definition({ id: 'other' }));
    }).toThrow(/sealed/);
  });

  it('is idempotent', () => {
    const library = createTemplateLibrary([definition()]);
    library.seal();
    expect(() => {
      library.seal();
    }).not.toThrow();
    expect(library.sealed).toBe(true);
  });

  it('refuses to seal an empty library', () => {
    expect(() => {
      createTemplateLibrary([]).seal();
    }).toThrow(/supply no prompts/);
  });

  it('freezes what it holds', () => {
    const library = createTemplateLibrary([definition()]);
    const template = library.get('planning.outline');

    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.metadata)).toBe(true);
    expect(Object.isFrozen(template.metadata.tags)).toBe(true);
    expect(Object.isFrozen(template.versions)).toBe(true);
    expect(Object.isFrozen(template.versions[0])).toBe(true);
    expect(Object.isFrozen(template.versions[0]?.compatibility)).toBe(true);
  });

  it('refuses a write rather than accepting one a cast made legal', () => {
    const template = createTemplateLibrary([definition()]).get('planning.outline');
    expect(() => {
      (template as unknown as { id: string }).id = 'something-else';
    }).toThrow(TypeError);
    expect(() => {
      (template.versions as unknown as { push: (v: unknown) => void }).push({});
    }).toThrow(TypeError);
  });

  it('reports a typed code on every refusal', () => {
    try {
      createTemplateLibrary([definition({ versions: [] })]);
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(isTemplateLibraryError(failure)).toBe(true);
      expect(isTemplateLibraryError(failure) && failure.code).toBe('Empty');
    }
  });
});

describe('helpers', () => {
  const library = createTemplateLibrary([
    definition({
      versions: [
        {
          prompt: prompt({ version: 1, status: 'deprecated' }),
          semanticVersion: '1.0.0',
          compatibility: compatibility(),
        },
        {
          prompt: prompt({ version: 4, status: 'active' }),
          semanticVersion: '1.2.0',
          compatibility: compatibility(),
        },
      ],
    }),
  ]);
  const template = library.get('planning.outline');

  it('produces the frozen reproducibility anchor', () => {
    expect(promptVersionStringOf(template.versions[1] as never)).toBe('planning.outline@4');
  });

  it('names the newest version by monotonic number', () => {
    expect(newestVersion(template).prompt.version).toBe(4);
  });

  it('sorts by semantic version, breaking ties on the monotonic number', () => {
    const sorted = bySemanticVersion(template.versions);
    expect(sorted.map((entry) => entry.prompt.version)).toEqual([1, 4]);
  });

  it('describes a version for an operator', () => {
    expect(describeVersion(template.versions[0] as never)).toBe(
      'planning.outline@1 (1.0.0, deprecated)',
    );
  });
});
