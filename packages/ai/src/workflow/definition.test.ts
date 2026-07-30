/**
 * Workflow definition validation.
 *
 * A definition is checked before a run starts, not as it goes: a workflow that
 * fails halfway through because step 4 names no model has already spent the
 * money for steps 1 to 3.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_WORKFLOW_STEPS,
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowValidationResult,
} from './definition.js';

function step(over: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 'outline',
    templateRef: { id: 'planning.outline' },
    capability: 'chat',
    model: 'gpt-4o',
    timeoutMs: 30_000,
    ...over,
  };
}

function definition(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'article.draft',
    version: 1,
    description: 'Outline, then draft.',
    steps: [step()],
    ...over,
  };
}

const codesOf = (r: WorkflowValidationResult): string[] =>
  r.ok ? [] : r.issues.map((i) => i.code);
const fieldsOf = (r: WorkflowValidationResult): string[] =>
  r.ok ? [] : r.issues.map((i) => i.field);

describe('a well-formed definition passes', () => {
  it('accepts the canonical shape', () => {
    expect(validateWorkflowDefinition(definition())).toEqual({ ok: true });
  });

  it('accepts several steps with distinct ids', () => {
    const d = definition({
      steps: [step({ id: 'outline', bindOutputTo: 'outline' }), step({ id: 'draft' })],
    });
    expect(validateWorkflowDefinition(d)).toEqual({ ok: true });
  });

  it('accepts a pinned template version', () => {
    const d = definition({
      steps: [step({ templateRef: { id: 'planning.outline', version: 7 } })],
    });
    expect(validateWorkflowDefinition(d).ok).toBe(true);
  });

  it('accepts stated parameters', () => {
    const d = definition({ steps: [step({ params: { temperature: 0, maxOutputTokens: 1 } })] });
    expect(validateWorkflowDefinition(d).ok).toBe(true);
  });
});

describe('definition integrity', () => {
  it('requires a dot.case id', () => {
    for (const id of ['draft', 'Article.Draft', 'article draft', '']) {
      expect(fieldsOf(validateWorkflowDefinition(definition({ id }))), id).toContain('id');
    }
  });

  it('requires a positive integer version', () => {
    for (const version of [0, -1, 1.5]) {
      expect(
        fieldsOf(validateWorkflowDefinition(definition({ version }))),
        String(version),
      ).toContain('version');
    }
  });

  it('requires a description', () => {
    expect(fieldsOf(validateWorkflowDefinition(definition({ description: '  ' })))).toContain(
      'description',
    );
  });

  // A definition that completes without executing anything looks like work and
  // is not.
  it('refuses a workflow with no steps', () => {
    expect(codesOf(validateWorkflowDefinition(definition({ steps: [] })))).toContain('EMPTY');
  });

  it('refuses a steps value that is not an array', () => {
    expect(
      codesOf(validateWorkflowDefinition(definition({ steps: 'outline' as never }))),
    ).toContain('NOT_ARRAY');
  });

  it('bounds the number of steps', () => {
    const steps = Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, (_, i) =>
      step({ id: `s-${String(i)}` }),
    );
    expect(codesOf(validateWorkflowDefinition(definition({ steps })))).toContain('TOO_MANY_STEPS');
  });
});

describe('step integrity', () => {
  it('requires a kebab-case step id', () => {
    for (const id of ['Outline', 'out line', 'out_line', '1outline', '']) {
      expect(
        fieldsOf(validateWorkflowDefinition(definition({ steps: [step({ id })] }))),
        id,
      ).toContain('steps[0].id');
    }
  });

  // Step ids form the idempotency key, so two steps sharing one would be
  // indistinguishable on retry.
  it('refuses two steps with one id', () => {
    const d = definition({ steps: [step(), step()] });
    expect(codesOf(validateWorkflowDefinition(d))).toContain('DUPLICATE_STEP');
  });

  it('requires a template reference', () => {
    const d = definition({ steps: [step({ templateRef: undefined as never })] });
    expect(fieldsOf(validateWorkflowDefinition(d))).toContain('steps[0].templateRef');
  });

  it('refuses a pinned version that is not a positive integer', () => {
    for (const version of [0, -1, 1.5]) {
      const d = definition({
        steps: [step({ templateRef: { id: 'planning.outline', version } })],
      });
      expect(fieldsOf(validateWorkflowDefinition(d)), String(version)).toContain(
        'steps[0].templateRef.version',
      );
    }
  });

  it('requires a capability, a model and a timeout', () => {
    expect(
      fieldsOf(
        validateWorkflowDefinition(
          definition({ steps: [step({ capability: undefined as never })] }),
        ),
      ),
    ).toContain('steps[0].capability');
    expect(
      fieldsOf(validateWorkflowDefinition(definition({ steps: [step({ model: '  ' })] }))),
    ).toContain('steps[0].model');
    for (const timeoutMs of [0, -1, 1.5]) {
      expect(
        fieldsOf(validateWorkflowDefinition(definition({ steps: [step({ timeoutMs })] }))),
        String(timeoutMs),
      ).toContain('steps[0].timeoutMs');
    }
  });

  it('bounds stated parameters', () => {
    const cases: [Partial<WorkflowStep['params']>, string][] = [
      [{ temperature: -1 }, 'steps[0].params.temperature'],
      [{ temperature: Number.NaN }, 'steps[0].params.temperature'],
      [{ maxOutputTokens: 0 }, 'steps[0].params.maxOutputTokens'],
      [{ maxOutputTokens: 1.5 }, 'steps[0].params.maxOutputTokens'],
    ];
    for (const [over, field] of cases) {
      const params = { temperature: 0.2, maxOutputTokens: 100, ...over };
      expect(
        fieldsOf(validateWorkflowDefinition(definition({ steps: [step({ params })] }))),
        field,
      ).toContain(field);
    }
  });

  it('refuses a step that is not an object', () => {
    expect(
      codesOf(validateWorkflowDefinition(definition({ steps: ['outline' as never] }))),
    ).toContain('NOT_OBJECT');
  });
});

describe('output binding — the whole of the data flow', () => {
  it('accepts a binding a later step could read', () => {
    const d = definition({
      steps: [step({ id: 'outline', bindOutputTo: 'outline' }), step({ id: 'draft' })],
    });
    expect(validateWorkflowDefinition(d).ok).toBe(true);
  });

  it('refuses a name that could never be a variable', () => {
    const d = definition({
      steps: [step({ id: 'outline', bindOutputTo: 'my-outline' }), step({ id: 'draft' })],
    });
    expect(codesOf(validateWorkflowDefinition(d))).toContain('BAD_NAME');
  });

  // The second write would win and the first step's output would vanish
  // between one step and the next, with nothing reporting it.
  it('refuses two steps binding to one name', () => {
    const d = definition({
      steps: [
        step({ id: 'one', bindOutputTo: 'text' }),
        step({ id: 'two', bindOutputTo: 'text' }),
        step({ id: 'three' }),
      ],
    });
    expect(codesOf(validateWorkflowDefinition(d))).toContain('DUPLICATE_BINDING');
  });

  // Nothing runs after the last step, so nothing could ever read it.
  it('refuses a binding on the last step', () => {
    const d = definition({ steps: [step({ id: 'outline', bindOutputTo: 'outline' })] });
    expect(codesOf(validateWorkflowDefinition(d))).toContain('UNREACHABLE_BINDING');
  });

  it('refuses a binding on the last of several steps', () => {
    const d = definition({
      steps: [step({ id: 'one' }), step({ id: 'two', bindOutputTo: 'text' })],
    });
    expect(codesOf(validateWorkflowDefinition(d))).toContain('UNREACHABLE_BINDING');
  });
});

describe('reporting', () => {
  // An author fixing a definition should see the whole picture in one cycle.
  it('reports every issue, not the first', () => {
    const d = definition({ id: 'BAD', version: 0, description: '' });
    expect(fieldsOf(validateWorkflowDefinition(d))).toEqual(
      expect.arrayContaining(['id', 'version', 'description']),
    );
  });

  it('reports issues across several steps', () => {
    const d = definition({ steps: [step({ model: '' }), step({ id: 'two', timeoutMs: 0 })] });
    expect(fieldsOf(validateWorkflowDefinition(d))).toEqual(
      expect.arrayContaining(['steps[0].model', 'steps[1].timeoutMs']),
    );
  });

  it('carries a code and a readable detail on every issue', () => {
    const result = validateWorkflowDefinition(definition({ id: 'BAD' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const issue of result.issues) {
      expect(issue.code).not.toBe('');
      expect(issue.detail.length).toBeGreaterThan(10);
    }
  });
});
