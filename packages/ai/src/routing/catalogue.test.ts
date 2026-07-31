import { describe, expect, it } from 'vitest';

import {
  CatalogueError,
  createModelCatalogue,
  isCatalogueError,
  type ModelEntry,
} from './catalogue.js';

const entry = (overrides: Partial<ModelEntry> = {}): ModelEntry => ({
  canonical: 'writing.standard',
  providerId: 'openai',
  providerModel: 'gpt-4o-2026-05-01',
  aliases: ['gpt-4o', 'standard'],
  capabilities: ['chat', 'text'],
  ...overrides,
});

const GOOGLE = entry({
  canonical: 'writing.fast',
  providerId: 'google',
  providerModel: 'gemini-2.5-flash-2026-04',
  aliases: ['fast'],
  capabilities: ['chat'],
});

describe('resolving a requested name', () => {
  it('resolves the canonical name', () => {
    const catalogue = createModelCatalogue([entry()]);
    expect(catalogue.lookup('openai', 'writing.standard')?.providerModel).toBe('gpt-4o-2026-05-01');
  });

  it('resolves an alias', () => {
    const catalogue = createModelCatalogue([entry()]);
    expect(catalogue.lookup('openai', 'gpt-4o')?.canonical).toBe('writing.standard');
    expect(catalogue.lookup('openai', 'standard')?.canonical).toBe('writing.standard');
  });

  it('resolves the vendor string itself, so a pinned integration keeps working', () => {
    const catalogue = createModelCatalogue([entry()]);
    expect(catalogue.lookup('openai', 'gpt-4o-2026-05-01')?.canonical).toBe('writing.standard');
  });

  it('resolves within a provider, never across one', () => {
    // The same alias may mean different models on different vendors, and
    // resolving one provider's name against another is how a plan ends up
    // naming a model the target does not have.
    const catalogue = createModelCatalogue([entry(), GOOGLE]);
    expect(catalogue.lookup('google', 'gpt-4o')).toBeNull();
    expect(catalogue.lookup('openai', 'fast')).toBeNull();
  });

  it('returns null for a name nothing knows', () => {
    expect(createModelCatalogue([entry()]).lookup('openai', 'gpt-9')).toBeNull();
  });
});

describe('a provider upgrade', () => {
  it('moves the vendor string and keeps the canonical name', () => {
    // The property the three-name split exists for: a year of cost reports and
    // audit records still refer to the same thing after a snapshot bump.
    const before = createModelCatalogue([entry()]);
    const after = createModelCatalogue([
      entry({ providerModel: 'gpt-4o-2026-11-01', aliases: ['gpt-4o', 'standard'] }),
    ]);

    expect(before.lookup('openai', 'gpt-4o')?.canonical).toBe(
      after.lookup('openai', 'gpt-4o')?.canonical,
    );
    expect(before.lookup('openai', 'gpt-4o')?.providerModel).not.toBe(
      after.lookup('openai', 'gpt-4o')?.providerModel,
    );
  });
});

describe('finding candidates across providers', () => {
  it('returns every entry answering to a name, in registration order', () => {
    const shared = [
      entry({ canonical: 'writing.standard', providerId: 'openai', aliases: ['standard'] }),
      entry({
        canonical: 'writing.standard',
        providerId: 'anthropic',
        providerModel: 'claude-sonnet-2026-03',
        aliases: ['standard'],
      }),
    ];
    const catalogue = createModelCatalogue(shared);

    expect(catalogue.candidates('standard').map((e) => e.providerId)).toEqual([
      'openai',
      'anthropic',
    ]);
  });

  it('is empty for an unknown name', () => {
    expect(createModelCatalogue([entry()]).candidates('nothing')).toEqual([]);
  });

  it('lists by capability, in registration order', () => {
    const catalogue = createModelCatalogue([entry(), GOOGLE]);
    expect(catalogue.supporting('chat').map((e) => e.providerId)).toEqual(['openai', 'google']);
    expect(catalogue.supporting('text').map((e) => e.providerId)).toEqual(['openai']);
    expect(catalogue.supporting('embedding')).toEqual([]);
  });

  it('lists by provider', () => {
    const catalogue = createModelCatalogue([entry(), GOOGLE]);
    expect(catalogue.entriesFor('google')).toHaveLength(1);
    expect(catalogue.entriesFor('nobody')).toEqual([]);
  });
});

describe('what the catalogue refuses', () => {
  it('refuses an entry missing any of its three names', () => {
    for (const field of ['canonical', 'providerId', 'providerModel'] as const) {
      expect(() => {
        createModelCatalogue([entry({ [field]: '  ' })]);
      }, field).toThrow(CatalogueError);
    }
  });

  it('refuses a model that declares no capabilities', () => {
    // It would sit in the catalogue being silently skipped by every filter.
    expect(() => {
      createModelCatalogue([entry({ capabilities: [] })]);
    }).toThrow(/no capabilities/);
  });

  it('refuses an empty alias', () => {
    expect(() => {
      createModelCatalogue([entry({ aliases: [''] })]);
    }).toThrow(CatalogueError);
  });

  it('refuses one name meaning two models on one provider', () => {
    // Which one won would depend on registration order, which is the opposite
    // of what a catalogue is for.
    expect(() =>
      createModelCatalogue([
        entry(),
        entry({ canonical: 'writing.other', providerModel: 'gpt-4o-mini', aliases: ['gpt-4o'] }),
      ]),
    ).toThrow(/cannot mean two models/);
  });

  it('refuses a duplicate canonical name on one provider', () => {
    expect(() =>
      createModelCatalogue([entry(), entry({ providerModel: 'gpt-4o-other', aliases: [] })]),
    ).toThrow(CatalogueError);
  });

  it('allows one canonical name on two providers, which is the point', () => {
    expect(() =>
      createModelCatalogue([
        entry({ aliases: [] }),
        entry({ providerId: 'anthropic', providerModel: 'claude', aliases: [] }),
      ]),
    ).not.toThrow();
  });

  it('reports a typed code on every refusal', () => {
    try {
      createModelCatalogue([entry({ canonical: '' })]);
      throw new Error('expected a refusal');
    } catch (failure) {
      expect(isCatalogueError(failure)).toBe(true);
      expect(isCatalogueError(failure) && failure.code).toBe('InvalidEntry');
    }
  });
});

describe('sealing', () => {
  it('refuses a registration after sealing', () => {
    const catalogue = createModelCatalogue([entry()]);
    catalogue.seal();
    expect(() => {
      catalogue.register(GOOGLE);
    }).toThrow(/sealed/);
  });

  it('is idempotent', () => {
    const catalogue = createModelCatalogue([entry()]);
    catalogue.seal();
    expect(() => {
      catalogue.seal();
    }).not.toThrow();
    expect(catalogue.sealed).toBe(true);
  });

  it('refuses to seal an empty catalogue', () => {
    expect(() => {
      createModelCatalogue([]).seal();
    }).toThrow(/route nothing/);
  });

  it('freezes what it holds, so an entry cannot be edited after registration', () => {
    const catalogue = createModelCatalogue([entry()]);
    const resolved = catalogue.lookup('openai', 'gpt-4o');
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved?.capabilities)).toBe(true);
    expect(() => {
      (resolved as unknown as { providerModel: string }).providerModel = 'something-else';
    }).toThrow(TypeError);
  });
});
