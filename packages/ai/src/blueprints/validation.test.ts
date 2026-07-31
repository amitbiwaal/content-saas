import { describe, expect, it } from 'vitest';

import { createTemplateLibrary } from '../templates/library.js';
import type { PromptTemplate } from '../prompts/template.js';
import { binds, outgoing, WORKFLOW_STEP_KINDS, type WorkflowStepDefinition } from './steps.js';
import { validateBlueprint } from './validation.js';

const template = (id: string): PromptTemplate => ({
  id,
  version: 1,
  taskType: id,
  status: 'active',
  parts: { system: 'S', user: 'U {{topic}}' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 512, temperature: 0.2, determinismRequired: false },
  evalSetRef: `evals/${id}`,
  owner: 'content-platform',
  changelog: 'Initial.',
});

const LIBRARY = createTemplateLibrary(
  ['planning.outline', 'writing.draft'].map((id) => ({
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
        compatibility: { capability: 'chat' as const, providers: null, models: null },
      },
    ],
  })),
);

const promptStep = (
  id: string,
  next: string | null,
  templateId = 'planning.outline',
): WorkflowStepDefinition => ({
  kind: 'prompt',
  id,
  description: `Render ${templateId}.`,
  templateRef: { id: templateId, selector: { kind: 'latest-stable' } },
  bindOutputTo: id.replace(/-/g, '_'),
  next,
});

const validate = (
  steps: readonly WorkflowStepDefinition[],
  entryStepId = 'first',
  withLibrary = true,
) =>
  validateBlueprint({
    steps,
    entryStepId,
    capability: 'chat',
    ...(withLibrary ? { library: LIBRARY } : {}),
  });

const codes = (result: ReturnType<typeof validate>): readonly string[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code);

describe('the step vocabulary', () => {
  it('declares exactly the five kinds', () => {
    expect([...WORKFLOW_STEP_KINDS]).toEqual([
      'prompt',
      'transform',
      'validate',
      'branch',
      'merge',
    ]);
  });

  it('reads every outgoing edge from one place', () => {
    // Three walks that each decided what an edge was would disagree on
    // `onFailure` first.
    expect(outgoing(promptStep('a', 'b'))).toEqual(['b']);
    expect(outgoing(promptStep('a', null))).toEqual([]);
    expect(
      outgoing({
        kind: 'branch',
        id: 'b',
        description: 'Fork.',
        on: 'verdict',
        cases: [
          { when: 'pass', next: 'x' },
          { when: 'fail', next: 'y' },
        ],
        otherwise: 'z',
      }),
    ).toEqual(['x', 'y', 'z']);
    expect(
      outgoing({
        kind: 'validate',
        id: 'v',
        description: 'Check.',
        validator: 'schema',
        subject: 'draft',
        next: 'ok',
        onFailure: 'bad',
      }),
    ).toEqual(['ok', 'bad']);
  });

  it('reports which steps bind a value into scope', () => {
    expect(binds(promptStep('a', null))).toBe('a');
    expect(
      binds({
        kind: 'validate',
        id: 'v',
        description: 'Check.',
        validator: 'schema',
        subject: 'draft',
        next: null,
        onFailure: null,
      }),
    ).toBeNull();
  });
});

describe('a valid blueprint', () => {
  it('accepts a straight line', () => {
    expect(validate([promptStep('first', 'second'), promptStep('second', null)])).toEqual({
      ok: true,
    });
  });

  it('accepts a branch that rejoins at a merge', () => {
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'fork'),
      {
        kind: 'branch',
        id: 'fork',
        description: 'Long or short.',
        on: 'first',
        cases: [
          { when: 'long', next: 'long-draft' },
          { when: 'short', next: 'short-draft' },
        ],
        otherwise: null,
      },
      promptStep('long-draft', 'join', 'writing.draft'),
      promptStep('short-draft', 'join', 'writing.draft'),
      {
        kind: 'merge',
        id: 'join',
        description: 'Combine.',
        sources: ['long-draft', 'short-draft'],
        bindOutputTo: 'combined',
        next: null,
      },
    ];
    expect(validate(steps)).toEqual({ ok: true });
  });

  it('accepts transform and validate steps', () => {
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'clean'),
      {
        kind: 'transform',
        id: 'clean',
        description: 'Strip markdown.',
        transform: 'strip-markdown',
        inputs: ['first'],
        bindOutputTo: 'cleaned',
        next: 'check',
      },
      {
        kind: 'validate',
        id: 'check',
        description: 'Schema check.',
        validator: 'outline-schema',
        subject: 'cleaned',
        next: null,
        onFailure: null,
      },
    ];
    expect(validate(steps)).toEqual({ ok: true });
  });
});

describe('step identity', () => {
  it('rejects an empty blueprint', () => {
    expect(codes(validate([]))).toEqual(['EMPTY']);
  });

  it('rejects a duplicate step id', () => {
    // Every edge naming it would be ambiguous, and which one ran would depend
    // on how the list happened to be ordered.
    const result = validate([promptStep('first', null), promptStep('first', null)]);
    expect(codes(result)).toContain('DUPLICATE');
  });

  it('rejects a step id that is not kebab-case', () => {
    expect(codes(validate([promptStep('First Step', null)], 'First Step'))).toContain('BAD_FORMAT');
  });

  it('rejects an unknown step kind', () => {
    const result = validate([
      { kind: 'summon', id: 'first', description: 'x' } as unknown as WorkflowStepDefinition,
    ]);
    expect(codes(result)).toContain('UNKNOWN_KIND');
  });

  it('rejects an entry step that is not declared', () => {
    expect(codes(validate([promptStep('first', null)], 'nowhere'))).toEqual(['UNKNOWN_STEP']);
  });

  it('rejects a binding name a template could not declare', () => {
    const step = { ...promptStep('first', null), bindOutputTo: 'not a name' };
    expect(codes(validate([step]))).toContain('BAD_FORMAT');
  });
});

describe('transitions', () => {
  it('rejects a transition to a step that does not exist', () => {
    expect(codes(validate([promptStep('first', 'nowhere')]))).toContain('UNKNOWN_TRANSITION');
  });

  it('rejects a branch case pointing nowhere', () => {
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'fork'),
      {
        kind: 'branch',
        id: 'fork',
        description: 'Fork.',
        on: 'first',
        cases: [{ when: 'a', next: 'ghost' }],
        otherwise: null,
      },
    ];
    expect(codes(validate(steps))).toContain('UNKNOWN_TRANSITION');
  });

  it('rejects a branch with no cases', () => {
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'fork'),
      {
        kind: 'branch',
        id: 'fork',
        description: 'Fork.',
        on: 'first',
        cases: [],
        otherwise: null,
      },
    ];
    expect(codes(validate(steps))).toContain('NO_CASES');
  });

  it('rejects a duplicate branch case', () => {
    // Which one matched would depend on evaluation order.
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'fork'),
      {
        kind: 'branch',
        id: 'fork',
        description: 'Fork.',
        on: 'first',
        cases: [
          { when: 'a', next: 'first' },
          { when: 'a', next: 'first' },
        ],
        otherwise: null,
      },
    ];
    expect(codes(validate(steps))).toContain('DUPLICATE_CASE');
  });

  it('rejects a merge of fewer than two steps', () => {
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'join'),
      {
        kind: 'merge',
        id: 'join',
        description: 'Join.',
        sources: ['first'],
        bindOutputTo: 'joined',
        next: null,
      },
    ];
    expect(codes(validate(steps))).toContain('TOO_FEW_SOURCES');
  });

  it('rejects a merge naming a step that does not exist', () => {
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'join'),
      {
        kind: 'merge',
        id: 'join',
        description: 'Join.',
        sources: ['first', 'ghost'],
        bindOutputTo: 'joined',
        next: null,
      },
    ];
    expect(codes(validate(steps))).toContain('UNKNOWN_STEP');
  });
});

describe('cycles', () => {
  it('rejects a step that returns to itself', () => {
    expect(codes(validate([promptStep('first', 'first')]))).toContain('CYCLE');
  });

  it('rejects a longer loop', () => {
    const result = validate([
      promptStep('first', 'second'),
      promptStep('second', 'third'),
      promptStep('third', 'first'),
    ]);
    expect(codes(result)).toContain('CYCLE');
  });

  it('names the path that closes the cycle, which is what a fix needs', () => {
    const result = validate([
      promptStep('first', 'second'),
      promptStep('second', 'third'),
      promptStep('third', 'second'),
    ]);
    if (result.ok) throw new Error('expected a refusal');
    const cycle = result.issues.find((issue) => issue.code === 'CYCLE');
    expect(cycle?.detail).toContain('second → third → second');
  });

  it('rejects a cycle through a branch', () => {
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'fork'),
      {
        kind: 'branch',
        id: 'fork',
        description: 'Fork.',
        on: 'first',
        cases: [{ when: 'again', next: 'first' }],
        otherwise: null,
      },
    ];
    expect(codes(validate(steps))).toContain('CYCLE');
  });

  it('accepts a diamond, which revisits a step without cycling', () => {
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'fork'),
      {
        kind: 'branch',
        id: 'fork',
        description: 'Fork.',
        on: 'first',
        cases: [
          { when: 'a', next: 'left' },
          { when: 'b', next: 'right' },
        ],
        otherwise: null,
      },
      promptStep('left', 'join', 'writing.draft'),
      promptStep('right', 'join', 'writing.draft'),
      {
        kind: 'merge',
        id: 'join',
        description: 'Join.',
        sources: ['left', 'right'],
        bindOutputTo: 'joined',
        next: null,
      },
    ];
    expect(validate(steps)).toEqual({ ok: true });
  });
});

describe('orphans', () => {
  it('rejects a step nothing reaches', () => {
    // It is work someone believes is happening.
    const result = validate([promptStep('first', null), promptStep('stranded', null)]);
    expect(codes(result)).toContain('ORPHAN');
  });

  it('names the orphan', () => {
    const result = validate([promptStep('first', null), promptStep('stranded', null)]);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.issues.find((issue) => issue.code === 'ORPHAN')?.field).toBe('steps.stranded');
  });

  it('does not call a step reached only through a branch default an orphan', () => {
    const steps: WorkflowStepDefinition[] = [
      promptStep('first', 'fork'),
      {
        kind: 'branch',
        id: 'fork',
        description: 'Fork.',
        on: 'first',
        cases: [{ when: 'a', next: 'left' }],
        otherwise: 'fallback',
      },
      promptStep('left', null, 'writing.draft'),
      promptStep('fallback', null, 'writing.draft'),
    ];
    expect(validate(steps)).toEqual({ ok: true });
  });
});

describe('template references', () => {
  it('rejects a template the library does not have', () => {
    expect(codes(validate([promptStep('first', null, 'nothing.here')]))).toContain(
      'UnknownTemplate',
    );
  });

  it('carries the library own code and reason rather than paraphrasing', () => {
    const result = validate([promptStep('first', null, 'nothing.here')]);
    if (result.ok) throw new Error('expected a refusal');
    const issue = result.issues[0];
    expect(issue?.code).toBe('UnknownTemplate');
    expect(issue?.detail).toContain("No template 'nothing.here'");
  });

  it('rejects a template whose capability does not match the workflow', () => {
    const result = validateBlueprint({
      steps: [promptStep('first', null)],
      entryStepId: 'first',
      capability: 'embedding',
      library: LIBRARY,
    });
    expect(codes(result)).toContain('CapabilityIncompatible');
  });

  it('skips template checks when no library is supplied', () => {
    // A blueprint can be validated for SHAPE without a catalogue in hand.
    expect(validate([promptStep('first', null, 'nothing.here')], 'first', false)).toEqual({
      ok: true,
    });
  });
});

describe('reporting', () => {
  it('reports every issue at once, not the first', () => {
    // A blueprint with four mistakes should be fixed in one pass.
    const result = validate([
      promptStep('first', 'ghost'),
      promptStep('stranded', null, 'nothing.here'),
    ]);
    expect(codes(result).length).toBeGreaterThanOrEqual(3);
    expect(codes(result)).toEqual(
      expect.arrayContaining(['UNKNOWN_TRANSITION', 'ORPHAN', 'UnknownTemplate']),
    );
  });

  it('freezes the issues it returns', () => {
    const result = validate([promptStep('first', 'ghost')]);
    if (result.ok) throw new Error('expected a refusal');
    expect(Object.isFrozen(result.issues)).toBe(true);
  });
});
