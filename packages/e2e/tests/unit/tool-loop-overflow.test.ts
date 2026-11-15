import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGrammarTools } from '@e2e-dev/core/lib/agent/primitives';
import { createToolLoopExecutor } from '@e2e-dev/core/lib/agent/tool-loop';
import { projectTools } from '@e2e-dev/core/lib/agent/default-agent';
import type { StepExecutor, StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';
import { defineTool } from '@e2e-dev/core/lib/agent/tool';
import { resolveConfig } from '../../src/config/resolve-run.ts';
import { defineEngine, type EngineHandle, type SemanticNode } from '@e2e-dev/core/lib/engine/index';
import { createEngineSession } from '@e2e-dev/core/lib/engine/session';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { createFixtures } from '@e2e-dev/core/lib/run/fixtures';
import { StepRecorder } from '@e2e-dev/core/lib/run/steps';
import { WorkerModels } from '@e2e-dev/core/lib/run/worker-models';
import type { E2EConfig } from '../../src/run-types.ts';
import { runAgentStepsOnFakeTime } from '../helpers/agent-fake-time.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { snapshot } from '../helpers/snapshot.ts';

runAgentStepsOnFakeTime();

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(engine: EngineHandle, overrides: Partial<E2EConfig> = {}) {
  const config = resolveConfig(
    { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides },
    { projectRoot: process.cwd(), env: {} },
  );
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const { fixtures } = createFixtures({
    config,
    target: config.targets[0]!,
    session: createEngineSession({ engine, targetName: 'fake' }),
    steps,
    budget: new AttemptBudget(signal, new Deadline(10_000)),
    runId: 'run',
    attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', titlePath: [], index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures, steps };
}

const engine = () => defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) });

/** A screen whose text is far longer than the overflow clip, as a dense page is. */
const bigScreen = () =>
  defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () =>
      snapshot(Array.from({ length: 600 }, (_, i) => ({ ref: { id: `n${String(i)}`, revision: '' }, role: 'text', name: `row ${String(i)} ${'x'.repeat(40)}` }))),
  });

/** The big screen with every line changed per variant, so each look after the first goes out whole, and pixels when asked. */
const changingBigScreen = (variant: () => number) =>
  defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async (_context, options) =>
      snapshot(
        Array.from({ length: 600 }, (_, i) => ({
          ref: { id: `n${String(i)}`, revision: '' },
          role: 'text',
          name: `v${String(variant())} row ${String(i)} ${'x'.repeat(40)}`,
        })),
        options?.pixels === true
          ? { pixels: { data: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1, scale: 1 }, maskedRegionCount: 0 }
          : {},
      ),
  });

/** A dense page whose sidebar sits at the end, as the review's repro: about 900 nodes, the sidebar last, so the overflow clip cuts it off the screen a later fold would name. The rows change per model turn, never per capture: the observation feed re-captures until the screen settles, and a variant that moved on every capture would never settle. */
const foldingBigScreen = (variant: () => number) =>
  defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () => {
      const rows = Array.from({ length: 880 }, (_, i) => ({
        ref: { id: `n${String(i)}`, revision: '' },
        role: 'text',
        name: `v${String(variant())} row ${String(i)} ${'x'.repeat(20)}`,
      }));
      const sidebar: SemanticNode = {
        ref: { id: 'n900', revision: '' },
        role: 'navigation',
        name: 'Sidebar',
        children: Array.from({ length: 12 }, (_, i) => ({
          ref: { id: `n${String(901 + i)}`, revision: '' },
          role: 'link',
          name: `Item ${String(i + 1)}`,
        })),
      };
      return snapshot([...rows, sidebar]);
    },
  });

const OVERFLOW = 'prompt is too long: 300000 tokens > 200000 maximum';

/** A read-only project tool, so the loop has a first turn to spend before the refusal. */
const peek = defineTool({ inputSchema: z.object({}), execute: async () => 'looked' }, { mutates: false });

/** The text of one direct `observe` call on a toolset built from the context, outside any loop. */
async function observeDirectly(context: StepExecutorContext): Promise<string> {
  const tools = createGrammarTools(context);
  const observe = tools.observe;
  if (observe?.execute === undefined) throw new Error('no observe tool');
  // The ToolSet type erases each tool's input to never; observe takes no input.
  const output = await observe.execute({} as never, { toolCallId: 'observe', messages: [], context: undefined });
  return typeof output === 'string' ? output : output.text;
}

describe('tool loop context overflow', () => {
  it.each(['act', 'assert'] as const)('shrinks overflow history for a %s loop unless inconclusiveOnOverflow is set', async kind => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'peek', input: {} }];
      if (turn === 2) throw new Error(OVERFLOW);
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the rows' } }];
    });
    const executor = kind === 'assert' ? createToolLoopExecutor({ name: 'custom-loop', tools: context => projectTools(context, { peek }), buildPrompt: async context => (await context.observe()).text }) : undefined;
    const { fixtures, steps } = runtime(bigScreen(), { agents: { default: executor === undefined ? { tools: { peek }, model } : { executor, model } } });

    await fixtures.agent[kind]('read the big output');

    expect(loopCalls).toHaveLength(3);
    // The second request carried the whole opening screen; the retried request
    // carries its head and a notice, and the tool result it follows is unchanged.
    expect(loopCalls[1]!.prompt.length).toBeGreaterThan(16_384);
    expect(loopCalls[2]!.prompt.length).toBeLessThan(16_384 + 200);
    expect(loopCalls[2]!.prompt).toContain("more characters cut: the request exceeded the model's context window");
    expect(loopCalls[2]!.lastToolResult).toBe(loopCalls[1]!.lastToolResult);
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
    // The refused request never answered, so it is not a model call the step paid for.
    expect(step.metrics?.modelCalls).toBe(2);
  });

  it('shrinks a pixel-mode history, where every screen rides a result with its screenshot, and retries', async () => {
    let variant = 0;
    const model = installFakeLoopModel(({ turn }) => {
      variant = turn;
      if (turn <= 2) return [{ toolName: 'screenshot', input: {} }];
      if (turn === 3) throw new Error(OVERFLOW);
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the rows' } }];
    });
    const { fixtures, steps } = runtime(changingBigScreen(() => variant), { agents: { default: { model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(4);
    // The two superseded screens outgrew the cache-friendly budget before the
    // refusal, so the request the provider refused already carried them
    // elided, the first screenshot's image still beside its lead.
    expect(loopCalls[2]!.prompt).toContain('[earlier screen elided');
    expect(loopCalls[2]!.toolResults[0]).toContain('[earlier screen elided');
    expect(loopCalls[2]!.toolResults[0]).toContain('"type":"file"');
    // What was left to shrink is the newest screen, riding the second screenshot's result.
    expect(loopCalls[3]!.lastToolResult).toContain("more characters cut: the request exceeded the model's context window");
    expect(loopCalls[3]!.lastToolResult).toContain('"type":"file"');
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
    expect(step.metrics?.modelCalls).toBe(3);
  });

  it('lists the next screen in full after the overflow retry cut the screen its folds named', async () => {
    let variant = 0;
    const model = installFakeLoopModel(({ turn }) => {
      variant = turn;
      if (turn === 1) return [{ toolName: 'observe', input: {} }];
      if (turn === 2) throw new Error(OVERFLOW);
      if (turn === 3) return [{ toolName: 'observe', input: {} }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the sidebar' } }];
    });
    const { fixtures, steps } = runtime(foldingBigScreen(() => variant), { agents: { default: { model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(4);
    // The second look folded the sidebar against the opening screen. The
    // revision it names is whatever the settling captures minted, so the
    // test reads it off the fold line instead of assuming b1.
    const folded = loopCalls[1]!.lastToolResult;
    const dependency = /\(\d+ nodes inside, unchanged since revision (b\d+)\)/.exec(folded)?.[1];
    expect(dependency).toMatch(/^b\d+$/);
    // The retry cut the opening screen's tail, sidebar included, and the
    // second screen's fold line with it.
    expect(loopCalls[2]!.prompt).toContain("more characters cut: the request exceeded the model's context window");
    expect(loopCalls[2]!.prompt).not.toContain('link "Item 1"');
    // The next look lists the sidebar in full instead of folding against a
    // screen the model no longer holds whole.
    const next = loopCalls[3]!.lastToolResult;
    expect(next).toMatch(/Current screen \(revision b\d+/);
    expect(next).toContain('#n901 link "Item 1"');
    expect(next).not.toContain('unchanged since revision');
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
    expect(step.metrics?.modelCalls).toBe(3);
  });

  it('lists the next screen in full after the overflow retry cut the screen its folds named, for a custom loop built from createGrammarTools', async () => {
    let variant = 0;
    const model = installFakeLoopModel(({ turn }) => {
      variant = turn;
      if (turn === 1) return [{ toolName: 'observe', input: {} }];
      if (turn === 2) throw new Error(OVERFLOW);
      if (turn === 3) return [{ toolName: 'observe', input: {} }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the sidebar' } }];
    });
    // The documented custom brain: the loop chassis plus the grammar tools,
    // with no presenter of its own. Its first observe lists the sidebar in
    // full, so the second look must not fold against the cut screen.
    const executor = createToolLoopExecutor({
      name: 'custom-loop',
      tools: (context) => createGrammarTools(context),
      buildPrompt: () => 'read the big output',
    });
    const { fixtures, steps } = runtime(foldingBigScreen(() => variant), { agents: { default: { executor, model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(4);
    // The first look listed the sidebar in full, at whatever revision the
    // settling captures minted.
    const first = loopCalls[1]!.lastToolResult;
    expect(first).toContain('#n901 link "Item 1"');
    expect(first).not.toContain('unchanged since revision');
    // The retry cut the first screen's tail, sidebar included: the opening
    // prompt carries no screen here, so the cut shows in the observe result
    // the retried request carries.
    expect(loopCalls[2]!.lastToolResult).toContain("more characters cut: the request exceeded the model's context window");
    expect(loopCalls[2]!.lastToolResult).not.toContain('link "Item 1"');
    // The next look lists the sidebar in full instead of folding against a
    // screen the model no longer holds whole.
    const next = loopCalls[3]!.lastToolResult;
    expect(next).toMatch(/Current screen \(revision b\d+/);
    expect(next).toContain('#n901 link "Item 1"');
    expect(next).not.toContain('unchanged since revision');
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
    expect(step.metrics?.modelCalls).toBe(3);
  });

  it('gives a second custom loop sharing one step context its own first screen', async () => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'observe', input: {} }];
      if (turn === 2) return [{ toolName: 'observe', input: {} }];
      if (turn === 3) return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'loop A read the sidebar' } }];
      if (turn === 4) return [{ toolName: 'observe', input: {} }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'loop B read the sidebar' } }];
    });
    // The review's repro: one custom runStep that runs two loops against the
    // same step context, each built from createGrammarTools. The screen never
    // changes, so a presenter shared across the loops would answer loop B's
    // first look with the screen loop A already showed.
    const loop = () =>
      createToolLoopExecutor({
        name: 'custom-loop',
        tools: (context) => createGrammarTools(context),
        buildPrompt: () => 'read the big output',
      });
    const executor: StepExecutor = {
      name: 'two-loops',
      runStep: async (context) => {
        await loop().runStep(context);
        return loop().runStep(context);
      },
    };
    const { fixtures, steps } = runtime(foldingBigScreen(() => 0), { agents: { default: { executor, model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(5);
    // Loop A's second look saw the screen it already holds, so the shared
    // presenter has state loop B never saw.
    const second = loopCalls[2]!.lastToolResult;
    expect(second).toContain('Screen unchanged since revision');
    // Loop B's first look lists the sidebar in full, as its own first screen,
    // instead of reporting the first loop's screen unchanged.
    const loopBFirst = loopCalls[4]!.lastToolResult;
    expect(loopBFirst).toMatch(/Current screen \(revision b\d+/);
    expect(loopBFirst).toContain('#n901 link "Item 1"');
    expect(loopBFirst).not.toContain('unchanged since revision');
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
  });

  it('gives each toolset built outside a loop its own first screen', async () => {
    let first: string | undefined;
    let second: string | undefined;
    // The review's repro: a custom runStep builds createGrammarTools twice,
    // once per model call, and calls observe on each. The screen never
    // changes, so a presenter shared across the toolsets would answer the
    // second look with the screen the first toolset already showed.
    const executor: StepExecutor = {
      name: 'two-toolsets',
      runStep: async (context) => {
        first = await observeDirectly(context);
        second = await observeDirectly(context);
        return { status: 'passed', summary: 'read the sidebar twice' };
      },
    };
    const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'unused' } }]);
    const { fixtures, steps } = runtime(foldingBigScreen(() => 0), { agents: { default: { executor, model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(0);
    // Each toolset's first look lists the sidebar in full, as its own first
    // screen, instead of reporting the other toolset's screen unchanged.
    for (const look of [first, second]) {
      expect(look).toMatch(/Current screen \(revision b\d+/);
      expect(look).toContain('#n901 link "Item 1"');
      expect(look).not.toContain('unchanged since revision');
    }
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
  });

  it('gives tools built after a loop run their own first screen', async () => {
    let after: string | undefined;
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'observe', input: {} }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'loop read the sidebar' } }];
    });
    // The review's second repro: a loop run, then createGrammarTools built
    // from the same step context and observed. The screen never changes, so
    // a presenter shared with the run would answer with the screen the
    // loop's model already holds.
    const loop = () =>
      createToolLoopExecutor({
        name: 'custom-loop',
        tools: (context) => createGrammarTools(context),
        buildPrompt: () => 'read the big output',
      });
    const executor: StepExecutor = {
      name: 'loop-then-tools',
      runStep: async (context) => {
        const verdict = await loop().runStep(context);
        after = await observeDirectly(context);
        return verdict;
      },
    };
    const { fixtures, steps } = runtime(foldingBigScreen(() => 0), { agents: { default: { executor, model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(2);
    // The loop's first look listed the sidebar in full.
    expect(loopCalls[1]!.lastToolResult).toContain('#n901 link "Item 1"');
    expect(loopCalls[1]!.lastToolResult).not.toContain('unchanged since revision');
    // The tools built after the run get their own first screen.
    expect(after).toMatch(/Current screen \(revision b\d+/);
    expect(after).toContain('#n901 link "Item 1"');
    expect(after).not.toContain('unchanged since revision');
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
  });

  it('reports CONTEXT_OVERFLOW when the shrunk request is refused again', async () => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'peek', input: {} }];
      throw new Error(OVERFLOW);
    });
    const { fixtures } = runtime(bigScreen(), { agents: { default: { tools: { peek }, model } } });

    await expect(fixtures.agent.act('read the big output')).rejects.toMatchObject({
      code: 'CONTEXT_OVERFLOW',
      message: expect.stringContaining('again after the history was shrunk once'),
    });
    expect(loopCalls).toHaveLength(3);
  });

  it('does not resend a request that shrinking would not change', async () => {
    const model = installFakeLoopModel(() => {
      throw new Error(OVERFLOW);
    });
    const { fixtures } = runtime(engine(), { agents: { default: { model } } });

    await expect(fixtures.agent.act('do the thing')).rejects.toMatchObject({
      code: 'CONTEXT_OVERFLOW',
      message: expect.stringContaining('had nothing left to shrink'),
    });
    // The opening request has no superseded screen and no long text: one
    // refusal is the verdict, not two.
    expect(loopCalls).toHaveLength(1);
  });

  it('leaves other provider failures to the ordinary error translation', async () => {
    const model = installFakeLoopModel(({ turn }) => {
      if (turn === 1) return [{ toolName: 'peek', input: {} }];
      throw new Error('Rate limit reached for requests');
    });
    const { fixtures } = runtime(engine(), { agents: { default: { tools: { peek }, model } } });

    await expect(fixtures.agent.act('read the big output')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
    expect(loopCalls).toHaveLength(2);
  });
});

it('fails an overflow as inconclusive without shrinking the history when inconclusiveOnOverflow is set', async () => {
  const model = installFakeLoopModel(() => { throw new Error(OVERFLOW); });
  const executor = createToolLoopExecutor({
    name: 'evidence-keeping-loop',
    inconclusiveOnOverflow: true,
    tools: () => ({}),
    buildPrompt: async context => (await context.observe()).text,
  });
  const { fixtures } = runtime(bigScreen(), { agents: { default: { model, executor } } });
  await expect(fixtures.agent.assert('inspect the evidence')).rejects.toMatchObject({ code: 'ASSERTION_INCONCLUSIVE' });
  expect(loopCalls).toHaveLength(1);
});
