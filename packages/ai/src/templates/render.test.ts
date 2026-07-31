import { describe, expect, it } from 'vitest';

import { PromptError, type PromptTemplate } from '../prompts/template.js';
import { createTemplateLibrary } from './library.js';
import type { TemplateCapability, TemplateMetadata } from './metadata.js';
import { RENDER_ORDER, renderCanonicalPrompt } from './render.js';
import { resolveTemplate, type ResolvedTemplate } from './resolve.js';

const prompt = (overrides: Partial<PromptTemplate> = {}): PromptTemplate => ({
  id: 'planning.outline',
  version: 2,
  taskType: 'planning.outline',
  status: 'active',
  parts: {
    system: 'You write outlines.',
    user: 'Write an outline about {{topic}} for {{audience}}.',
  },
  variables: [
    { name: 'topic', type: 'string', required: true, description: 'The subject.' },
    { name: 'audience', type: 'string', required: true, description: 'Who it is for.' },
  ],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
  ...overrides,
});

const metadata: TemplateMetadata = {
  title: 'Article outline',
  description: 'Produces a structured outline.',
  owner: 'content-platform',
  visibility: 'public',
  tags: [],
};

const compatibility: TemplateCapability = { capability: 'chat', providers: null, models: null };

function resolvedFor(template: PromptTemplate = prompt()): ResolvedTemplate {
  const library = createTemplateLibrary([
    {
      id: template.id,
      metadata,
      versions: [{ prompt: template, semanticVersion: '1.2.0', compatibility }],
    },
  ]);
  const result = resolveTemplate({
    library,
    id: template.id,
    selector: { kind: 'explicit', version: template.version },
  });
  if (result.outcome !== 'resolved') throw new Error('expected a resolution');
  return result.resolved;
}

const render = (template?: PromptTemplate, variables?: Record<string, unknown>) =>
  renderCanonicalPrompt({
    resolved: resolvedFor(template),
    variables: variables ?? { topic: 'espresso', audience: 'baristas' },
    tenantId: 'ws-1',
    correlationId: 'corr-1',
  });

describe('the canonical prompt', () => {
  it('carries the identity, both versions and the anchor', () => {
    const canonical = render();

    expect(canonical.templateId).toBe('planning.outline');
    expect(canonical.templateVersion).toBe(2);
    expect(canonical.semanticVersion).toBe('1.2.0');
    expect(canonical.promptVersion).toBe('planning.outline@2');
    expect(canonical.taskType).toBe('planning.outline');
    expect(canonical.capability).toBe('chat');
  });

  it('carries the messages the frozen compiler produced', () => {
    const canonical = render();

    expect(canonical.messages).toHaveLength(2);
    expect(canonical.messages[0]).toEqual({ role: 'system', content: 'You write outlines.' });
    expect(canonical.messages[1]?.content).toBe('Write an outline about espresso for baristas.');
  });

  it('carries the hints for the Router, unapplied', () => {
    // The template's hints are metadata here; nothing in this library builds a
    // request or chooses sampling.
    expect(render().hints).toEqual({
      maxOutputTokens: 1024,
      temperature: 0.2,
      determinismRequired: false,
    });
  });

  it('measures what was actually rendered', () => {
    const canonical = render();
    const total = canonical.messages.reduce((sum, message) => sum + message.content.length, 0);
    expect(canonical.promptChars).toBe(total);
  });

  it('carries what the version declares itself compatible with', () => {
    expect(render().compatibility).toEqual(compatibility);
  });
});

describe('render order', () => {
  it('is system, then developer, then user', () => {
    expect([...RENDER_ORDER]).toEqual(['system', 'developer', 'user']);
  });

  it('reports only the parts a template declared', () => {
    expect(render().parts).toEqual(['system', 'user']);
  });

  it('reports the developer part when one is declared', () => {
    const withDeveloper = prompt({
      parts: {
        system: 'You write outlines.',
        developer: 'Never invent a citation.',
        user: 'Write an outline about {{topic}} for {{audience}}.',
      },
    });
    expect(render(withDeveloper).parts).toEqual([...RENDER_ORDER]);
  });

  it('composes the developer part into the system message, after the system text', () => {
    // Not a fourth role: the platform's vocabulary is system | user | assistant
    // and is frozen, so developer text belongs with the role and constraints.
    const withDeveloper = prompt({
      parts: {
        system: 'SYSTEM-TEXT',
        developer: 'DEVELOPER-TEXT',
        user: 'USER-TEXT {{topic}} {{audience}}',
      },
    });
    const canonical = render(withDeveloper);

    expect(canonical.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(canonical.messages[0]?.content).toBe('SYSTEM-TEXT\n\nDEVELOPER-TEXT');
    expect(canonical.messages[0]?.content.indexOf('SYSTEM-TEXT')).toBeLessThan(
      canonical.messages[0]?.content.indexOf('DEVELOPER-TEXT') ?? -1,
    );
  });
});

describe('variables', () => {
  it('substitutes every declared slot', () => {
    expect(render(undefined, { topic: 'tea', audience: 'novices' }).messages[1]?.content).toBe(
      'Write an outline about tea for novices.',
    );
  });

  it('rejects a missing required variable', () => {
    expect(() => render(undefined, { topic: 'tea' })).toThrow(PromptError);
  });

  it('rejects an unknown variable rather than ignoring it', () => {
    // Silently dropping one means a caller believes it influenced the prompt.
    expect(() =>
      render(undefined, { topic: 'tea', audience: 'novices', extra: 'ignored?' }),
    ).toThrow(PromptError);
  });

  it('rejects a value of the wrong type', () => {
    expect(() => render(undefined, { topic: 42, audience: 'novices' })).toThrow(PromptError);
  });

  it('accepts an omitted optional variable', () => {
    const optional = prompt({
      parts: { system: 'S', user: 'U {{topic}}{{note}}' },
      variables: [
        { name: 'topic', type: 'string', required: true, description: 'The subject.' },
        { name: 'note', type: 'string', required: false, description: 'An aside.' },
      ],
    });
    expect(() => render(optional, { topic: 'tea' })).not.toThrow();
  });

  it('throws the PIPELINE error, not a second one wrapped around it', () => {
    // A caller catching two error types for one failure will catch one of them.
    try {
      render(undefined, { topic: 'tea' });
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(failure).toBeInstanceOf(PromptError);
    }
  });
});

describe('purity', () => {
  it('produces byte-identical output for identical inputs', () => {
    // `prompt-engine.md` domain rule 9, and the reason a historical call can be
    // reproduced at all.
    expect(JSON.stringify(render())).toBe(JSON.stringify(render()));
  });

  it('is unaffected by the tenancy it carries', () => {
    const base = renderCanonicalPrompt({
      resolved: resolvedFor(),
      variables: { topic: 'espresso', audience: 'baristas' },
      tenantId: 'ws-1',
      correlationId: 'corr-1',
    });
    const elsewhere = renderCanonicalPrompt({
      resolved: resolvedFor(),
      variables: { topic: 'espresso', audience: 'baristas' },
      tenantId: 'ws-2',
      correlationId: 'corr-2',
    });
    expect(elsewhere).toEqual(base);
  });

  it('is deeply frozen', () => {
    const canonical = render();
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.messages)).toBe(true);
    expect(Object.isFrozen(canonical.messages[0])).toBe(true);
    expect(Object.isFrozen(canonical.parts)).toBe(true);
    expect(() => {
      (canonical as unknown as { promptVersion: string }).promptVersion = 'other@1';
    }).toThrow(TypeError);
  });

  it('formats nothing for a provider', () => {
    // No vendor shapes: the messages are the platform's own role vocabulary,
    // and an adapter maps them.
    for (const message of render().messages) {
      expect(['system', 'user', 'assistant']).toContain(message.role);
      expect(Object.keys(message).sort()).toEqual(['content', 'role']);
    }
  });
});
