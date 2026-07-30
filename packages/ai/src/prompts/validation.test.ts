/**
 * Template validation.
 *
 * A template is validated when the catalogue is built, not when a customer's
 * request arrives — so what these assert is that a broken template cannot ship,
 * rather than that it fails gracefully.
 */
import { describe, expect, it } from 'vitest';

import type { PromptTemplate, VariableDeclaration } from './template.js';
import {
  MAX_TEMPLATE_CHARS,
  placeholdersIn,
  validatePromptTemplate,
  type PromptValidationResult,
} from './validation.js';

function variable(over: Partial<VariableDeclaration> = {}): VariableDeclaration {
  return { name: 'topic', type: 'string', required: true, description: 'The subject.', ...over };
}

function template(over: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'planning.outline',
    version: 7,
    taskType: 'planning.outline',
    status: 'active',
    parts: {
      system: 'You write outlines.',
      user: 'Write an outline about {{topic}}.',
    },
    variables: [variable()],
    modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
    evalSetRef: 'evals/planning.outline',
    owner: 'content-platform',
    changelog: 'Initial version.',
    ...over,
  };
}

const codesOf = (result: PromptValidationResult): string[] =>
  result.ok ? [] : result.issues.map((i) => i.code);

const fieldsOf = (result: PromptValidationResult): string[] =>
  result.ok ? [] : result.issues.map((i) => i.field);

describe('a well-formed template passes', () => {
  it('accepts the canonical shape', () => {
    expect(validatePromptTemplate(template())).toEqual({ ok: true });
  });

  it('accepts a developer part and a context slot', () => {
    const t = template({
      parts: {
        system: 'You write outlines.',
        developer: 'Never invent a citation.',
        user: 'Write about {{topic}}.',
      },
      contextSlot: { position: 'before_user', framing: 'data_block' },
    });
    expect(validatePromptTemplate(t)).toEqual({ ok: true });
  });

  it('accepts a template with no variables at all', () => {
    const t = template({ parts: { system: 'You summarise.', user: 'Summarise.' }, variables: [] });
    expect(validatePromptTemplate(t)).toEqual({ ok: true });
  });

  it('accepts every declared variable type', () => {
    const types = ['string', 'number', 'boolean', 'string[]', 'object'] as const;
    for (const type of types) {
      const t = template({
        parts: { system: 's', user: 'x {{topic}}' },
        variables: [variable({ type })],
      });
      expect(validatePromptTemplate(t).ok, type).toBe(true);
    }
  });
});

describe('placeholder syntax', () => {
  it('finds every well-formed slot in order', () => {
    expect(placeholdersIn('a {{one}} b {{two}} c {{one}}')).toEqual(['one', 'two', 'one']);
  });

  it('ignores inner whitespace, so two spellings are one slot', () => {
    expect(placeholdersIn('{{ topic }} and {{topic}}')).toEqual(['topic', 'topic']);
  });

  // Prompts routinely contain JSON, both as an example of the output wanted and
  // as data. Single braces had to stay literal or every author would be
  // escaping ordinary content.
  it('leaves JSON alone', () => {
    expect(placeholdersIn('Return {"a": 1, "b": {"c": 2}}')).toEqual([]);
  });

  it('rejects an unclosed placeholder', () => {
    const t = template({ parts: { system: 's', user: '{{topic}} and {{unclosed' } });
    expect(codesOf(validatePromptTemplate(t))).toContain('MALFORMED_PLACEHOLDER');
  });

  it('rejects a name that cannot be a variable', () => {
    for (const bad of ['{{1abc}}', '{{}}', '{{a-b}}', '{{ }}']) {
      const t = template({ parts: { system: 's', user: `{{topic}} ${bad}` } });
      expect(codesOf(validatePromptTemplate(t)), bad).toContain('MALFORMED_PLACEHOLDER');
    }
  });

  // A slot with no declaration can never be filled, so the model sees a hole in
  // the instruction and answers around it.
  it('rejects a placeholder nothing declares', () => {
    const t = template({ parts: { system: 's', user: '{{topic}} in {{tone}}' } });
    expect(codesOf(validatePromptTemplate(t))).toContain('UNKNOWN_PLACEHOLDER');
  });

  it('names which part the unknown placeholder is in', () => {
    const t = template({ parts: { system: 'Be {{tone}}.', user: '{{topic}}' } });
    expect(fieldsOf(validatePromptTemplate(t))).toContain('parts.system');
  });

  it('checks the developer part too', () => {
    const t = template({
      parts: { system: 's', developer: '{{unknown}}', user: '{{topic}}' },
    });
    expect(codesOf(validatePromptTemplate(t))).toContain('UNKNOWN_PLACEHOLDER');
  });

  // The other direction: a caller forced to supply a value that appears nowhere
  // is one whose data silently fails to reach the model.
  it('rejects a declaration that appears in no part', () => {
    const t = template({ variables: [variable(), variable({ name: 'unused' })] });
    expect(codesOf(validatePromptTemplate(t))).toContain('UNUSED_VARIABLE');
  });
});

describe('variable declarations', () => {
  // Two declarations of one name means the second silently wins, and which
  // constraint applies depends on declaration order.
  it('rejects a duplicate variable', () => {
    const t = template({
      variables: [variable(), variable({ maxLength: 10 })],
    });
    expect(codesOf(validatePromptTemplate(t))).toContain('DUPLICATE_VARIABLE');
  });

  it('rejects a duplicate even when the two differ in type', () => {
    const t = template({ variables: [variable(), variable({ type: 'number' })] });
    expect(codesOf(validatePromptTemplate(t))).toContain('DUPLICATE_VARIABLE');
  });

  it('rejects a name that could never be a placeholder', () => {
    for (const name of ['1topic', 'my-topic', '', 'a b']) {
      const t = template({ variables: [variable({ name })] });
      expect(codesOf(validatePromptTemplate(t)), name).toContain('BAD_NAME');
    }
  });

  it('rejects an unknown type', () => {
    const t = template({ variables: [variable({ type: 'date' as never })] });
    expect(codesOf(validatePromptTemplate(t))).toContain('BAD_TYPE');
  });

  it('requires an enum to list its values', () => {
    const t = template({ variables: [variable({ type: 'enum' })] });
    expect(codesOf(validatePromptTemplate(t))).toContain('MISSING');
  });

  // A constraint that is never checked reads as a guarantee.
  it('rejects enumValues on a type that would never check them', () => {
    const t = template({ variables: [variable({ type: 'string', enumValues: ['a'] })] });
    expect(codesOf(validatePromptTemplate(t))).toContain('NOT_APPLICABLE');
  });

  it('rejects maxLength on a type it cannot bound', () => {
    const t = template({ variables: [variable({ type: 'number', maxLength: 5 })] });
    expect(codesOf(validatePromptTemplate(t))).toContain('NOT_APPLICABLE');
  });

  it('accepts maxLength on text', () => {
    for (const type of ['string', 'string[]'] as const) {
      const t = template({ variables: [variable({ type, maxLength: 50 })] });
      expect(validatePromptTemplate(t).ok, type).toBe(true);
    }
  });

  it('requires a description', () => {
    const t = template({ variables: [variable({ description: '  ' })] });
    expect(fieldsOf(validatePromptTemplate(t))).toContain('variables[0].description');
  });
});

describe('template integrity', () => {
  it('requires a dot.case id, stable forever', () => {
    for (const id of ['planning', 'Planning.Outline', 'planning outline', '']) {
      expect(fieldsOf(validatePromptTemplate(template({ id }))), id).toContain('id');
    }
  });

  it('requires a positive integer version', () => {
    for (const version of [0, -1, 1.5]) {
      expect(fieldsOf(validatePromptTemplate(template({ version }))), String(version)).toContain(
        'version',
      );
    }
  });

  it('requires a known lifecycle state', () => {
    expect(fieldsOf(validatePromptTemplate(template({ status: 'live' as never })))).toContain(
      'status',
    );
  });

  it('requires the system and user parts', () => {
    expect(
      fieldsOf(validatePromptTemplate(template({ parts: { system: ' ', user: '{{topic}}' } }))),
    ).toContain('parts.system');
    expect(
      fieldsOf(validatePromptTemplate(template({ parts: { system: 's', user: '  ' } }))),
    ).toContain('parts.user');
  });

  // Retrieved web content arrives through the context slot. There is one framing.
  it('rejects any context framing but a data block', () => {
    const t = template({
      contextSlot: { position: 'before_user', framing: 'instruction' as never },
    });
    expect(codesOf(validatePromptTemplate(t))).toContain('BAD_FRAMING');
  });

  it('rejects an unknown slot position', () => {
    const t = template({
      contextSlot: { position: 'inline' as never, framing: 'data_block' },
    });
    expect(fieldsOf(validatePromptTemplate(t))).toContain('contextSlot.position');
  });

  it('requires model hints, since unstated sampling is a vendor default', () => {
    expect(
      fieldsOf(validatePromptTemplate(template({ modelHints: undefined as never }))),
    ).toContain('modelHints');
  });

  it('bounds the model hints', () => {
    const cases: [Partial<PromptTemplate['modelHints']>, string][] = [
      [{ temperature: -1 }, 'modelHints.temperature'],
      [{ temperature: Number.NaN }, 'modelHints.temperature'],
      [{ maxOutputTokens: 0 }, 'modelHints.maxOutputTokens'],
      [{ maxOutputTokens: 1.5 }, 'modelHints.maxOutputTokens'],
      [{ seed: 1.5 }, 'modelHints.seed'],
    ];
    for (const [hints, field] of cases) {
      const modelHints = {
        maxOutputTokens: 100,
        temperature: 0.2,
        determinismRequired: false,
        ...hints,
      };
      expect(fieldsOf(validatePromptTemplate(template({ modelHints }))), field).toContain(field);
    }
  });

  // Mandatory by domain rule 3: it is what stops the catalogue accumulating
  // prompts nobody can safely change.
  it('requires an evaluation set', () => {
    expect(fieldsOf(validatePromptTemplate(template({ evalSetRef: '  ' })))).toContain(
      'evalSetRef',
    );
  });

  it('requires an owner and a changelog', () => {
    expect(fieldsOf(validatePromptTemplate(template({ owner: '' })))).toContain('owner');
    expect(fieldsOf(validatePromptTemplate(template({ changelog: '' })))).toContain('changelog');
  });

  it('bounds the template size', () => {
    const t = template({
      parts: { system: 's', user: `{{topic}}${'x'.repeat(MAX_TEMPLATE_CHARS)}` },
    });
    expect(codesOf(validatePromptTemplate(t))).toContain('TEMPLATE_TOO_LARGE');
  });

  // An author fixing a template should see the whole picture in one cycle.
  it('reports every issue, not the first', () => {
    const t = template({ id: 'BAD', version: 0, owner: '', evalSetRef: '' });
    expect(fieldsOf(validatePromptTemplate(t))).toEqual(
      expect.arrayContaining(['id', 'version', 'owner', 'evalSetRef']),
    );
  });

  it('carries a code and a readable detail on every issue', () => {
    const result = validatePromptTemplate(template({ id: 'BAD' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const issue of result.issues) {
      expect(issue.code).not.toBe('');
      expect(issue.detail.length).toBeGreaterThan(10);
    }
  });
});
