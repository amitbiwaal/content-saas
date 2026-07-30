/**
 * The resolver and the catalogue.
 *
 * There is no fallback prompt, ever. An unknown id or an unresolvable version
 * fails the request, because substituting a generic prompt produces output that
 * looks valid and is traceable to no version at all.
 */
import { describe, expect, it } from 'vitest';

import { createPromptCatalogue } from './resolver.js';
import { PromptError, type PromptInput, type PromptTemplate } from './template.js';

function template(over: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'planning.outline',
    version: 7,
    taskType: 'planning.outline',
    status: 'active',
    parts: { system: 'You write outlines.', user: 'Write about {{topic}}.' },
    variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
    modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
    evalSetRef: 'evals/planning.outline',
    owner: 'content-platform',
    changelog: 'Initial version.',
    ...over,
  };
}

const input = (over: Partial<PromptInput> = {}): PromptInput => ({
  templateRef: { id: 'planning.outline' },
  variables: { topic: 'espresso' },
  tenantId: '018f7a1e-0000-7000-8000-0000000000bb',
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  ...over,
});

describe('the catalogue is verified when it is built', () => {
  // A broken template discovered on the first customer request is a broken
  // template that shipped.
  it('refuses to build on an invalid template', () => {
    expect(() => createPromptCatalogue([template({ evalSetRef: '' })])).toThrow(PromptError);
  });

  it('reports that as InvalidTemplate and names the template', () => {
    try {
      createPromptCatalogue([template({ id: 'BAD' })]);
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as PromptError).code).toBe('InvalidTemplate');
      expect((error as PromptError).message).toContain('BAD@7');
    }
  });

  // A composition root wrong in two places should learn both at once.
  it('reports every broken template, not the first', () => {
    try {
      createPromptCatalogue([
        template({ id: 'a.one', owner: '' }),
        template({ id: 'a.two', changelog: '' }),
      ]);
      expect.unreachable('must refuse');
    } catch (error) {
      expect((error as PromptError).message).toContain('a.one@7');
      expect((error as PromptError).message).toContain('a.two@7');
    }
  });

  // A version is immutable and singular; two declarations of one version means
  // the winner depends on declaration order.
  it('refuses a version declared twice', () => {
    expect(() => createPromptCatalogue([template(), template({ owner: 'someone-else' })])).toThrow(
      /declared more than once/,
    );
  });

  // Two would make an unversioned ref ambiguous.
  it('refuses two active versions of one id', () => {
    expect(() =>
      createPromptCatalogue([template({ version: 7 }), template({ version: 8 })]),
    ).toThrow(/two active versions/);
  });

  it('accepts one active version alongside deprecated ones', () => {
    expect(() =>
      createPromptCatalogue([
        template({ version: 6, status: 'deprecated' }),
        template({ version: 7, status: 'active' }),
        template({ version: 8, status: 'draft' }),
      ]),
    ).not.toThrow();
  });

  it('builds an empty catalogue', () => {
    const catalogue = createPromptCatalogue([]);
    expect(catalogue.list()).toEqual([]);
    expect(catalogue.listIds()).toEqual([]);
  });
});

describe('resolution', () => {
  const catalogue = createPromptCatalogue([
    template({ version: 6, status: 'deprecated' }),
    template({ version: 7, status: 'active' }),
    template({ version: 8, status: 'draft' }),
    template({ id: 'research.query', taskType: 'research.query', version: 1, status: 'active' }),
  ]);

  it('resolves an unversioned ref to the active version', () => {
    expect(catalogue.resolve({ id: 'planning.outline' }).version).toBe(7);
  });

  it('resolves a pinned version, whatever its state', () => {
    expect(catalogue.resolve({ id: 'planning.outline', version: 6 }).status).toBe('deprecated');
    expect(catalogue.resolve({ id: 'planning.outline', version: 8 }).status).toBe('draft');
  });

  it('throws TemplateNotFound for an id nobody declared', () => {
    try {
      catalogue.resolve({ id: 'nobody.here' });
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as PromptError).code).toBe('TemplateNotFound');
    }
  });

  it('names what IS declared, so a typo is visible', () => {
    expect(() => catalogue.resolve({ id: 'planning.outlin' })).toThrow(/planning\.outline/);
  });

  it('throws TemplateVersionNotFound for a version that does not exist', () => {
    try {
      catalogue.resolve({ id: 'planning.outline', version: 99 });
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as PromptError).code).toBe('TemplateVersionNotFound');
      expect((error as PromptError).message).toContain('6, 7, 8');
    }
  });

  // One is a typo; the other is a template that exists but nothing may use yet.
  it('distinguishes an unknown id from an id with no active version', () => {
    const drafts = createPromptCatalogue([template({ status: 'draft' })]);
    try {
      drafts.resolve({ id: 'planning.outline' });
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as PromptError).code).toBe('TemplateVersionNotFound');
      expect((error as PromptError).message).toContain('no active version');
    }
  });

  it('reports absence without throwing, for callers that can cope', () => {
    expect(catalogue.has({ id: 'planning.outline' })).toBe(true);
    expect(catalogue.has({ id: 'planning.outline', version: 6 })).toBe(true);
    expect(catalogue.has({ id: 'planning.outline', version: 99 })).toBe(false);
    expect(catalogue.has({ id: 'nobody.here' })).toBe(false);
  });

  it('has no active version to offer an unversioned draft-only ref', () => {
    const drafts = createPromptCatalogue([template({ status: 'draft' })]);
    expect(drafts.has({ id: 'planning.outline' })).toBe(false);
  });

  it('lists ids and versions', () => {
    expect(catalogue.listIds()).toEqual(['planning.outline', 'research.query']);
    expect(catalogue.versionsOf('planning.outline')).toEqual([6, 7, 8]);
    expect(catalogue.versionsOf('nobody.here')).toEqual([]);
  });

  it('hands out frozen lists', () => {
    expect(Object.isFrozen(catalogue.list())).toBe(true);
    expect(Object.isFrozen(catalogue.listIds())).toBe(true);
    expect(Object.isFrozen(catalogue.versionsOf('planning.outline'))).toBe(true);
  });
});

describe('render — resolve, then compile', () => {
  const catalogue = createPromptCatalogue([
    template({ version: 6, status: 'deprecated', parts: { system: 'Old.', user: '{{topic}} v6' } }),
    template({ version: 7, status: 'active' }),
  ]);

  it('renders through the active version', () => {
    const compiled = catalogue.render(input());
    expect(compiled.promptVersion).toBe('planning.outline@7');
    expect(compiled.messages[1]?.content).toBe('Write about espresso.');
  });

  // Workflows pin at run start, so a promotion mid-run must not change what
  // they are running.
  it('renders a pinned deprecated version unchanged', () => {
    const compiled = catalogue.render(
      input({ templateRef: { id: 'planning.outline', version: 6 } }),
    );
    expect(compiled.promptVersion).toBe('planning.outline@6');
    expect(compiled.messages[1]?.content).toBe('espresso v6');
  });

  it('fails the request rather than falling back to another version', () => {
    expect(() => catalogue.render(input({ templateRef: { id: 'nobody.here' } }))).toThrow(
      PromptError,
    );
  });

  it('propagates a binding failure from the compiler', () => {
    expect(() => catalogue.render(input({ variables: {} }))).toThrow(/required/);
  });

  it('renders identically every time', () => {
    expect(JSON.stringify(catalogue.render(input()))).toBe(
      JSON.stringify(catalogue.render(input())),
    );
  });

  it('passes context through to the compiler', () => {
    const withSlot = createPromptCatalogue([
      template({ contextSlot: { position: 'before_user', framing: 'data_block' } }),
    ]);
    const compiled = withSlot.render(input(), { blocks: [{ ref: 'a', content: 'evidence' }] });
    expect(compiled.messages[1]?.content).toContain('evidence');
  });
});
