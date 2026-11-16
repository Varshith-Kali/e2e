import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGrammarTools } from '@e2e-dev/core/lib/agent/primitives';
import { createToolLoopExecutor } from '@e2e-dev/core/lib/agent/tool-loop';
import { createBuiltInAgent, projectTools } from '@e2e-dev/core/lib/agent/default-agent';
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

/** A dense page with no interactive node, as a canvas-like screen is: the built-in act loop then looks twice, the second time asking for pixels, so the two opening renders of overlapping runs interleave. The rows change per variant; the sidebar is plain text, so it can fold. */
/** A dense page for the overlapping-opening-prompts test. The first look
 * returns a sidebar of plain text, so the act loop's opening look finds no
 * interactive node and looks a second time asking for pixels; every later
 * look returns the sidebar as links. The first run therefore renders its
 * opening after the second run's, which is what lets a presenter read after
 * the first await overwrite the second run's fold record. The rows change
 * per variant; the sidebar never does, so it can fold. */
const foldingStillScreen = (variant: () => number) => {
  let calls = 0;
  return defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () => {
      calls += 1;
      const links = calls > 2;
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
          role: links ? 'link' : 'text',
          name: `Item ${String(i + 1)}`,
        })),
      };
      return snapshot([...rows, sidebar]);
    },
  });
};

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

  it('lists the next screen in full after the overflow retry cut the screen its folds named, for tools built before the loop run', async () => {
    let variant = 0;
    const model = installFakeLoopModel(({ turn }) => {
      variant = turn;
      if (turn === 1) return [{ toolName: 'observe', input: {} }];
      if (turn === 2) return [{ toolName: 'observe', input: {} }];
      if (turn === 3) throw new Error(OVERFLOW);
      if (turn === 4) return [{ toolName: 'observe', input: {} }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the sidebar' } }];
    });
    // The review's repro: the custom executor builds the grammar tools from
    // the step context before the loop run starts and hands the same set to
    // the loop, so the tools keep a presenter of their own and the loop's
    // overflow retry must clear its folds too.
    const executor: StepExecutor = {
      name: 'prebuilt-tools-loop',
      runStep: async (context) => {
        const tools = createGrammarTools(context);
        const loop = createToolLoopExecutor({
          name: 'custom-loop',
          tools: () => tools,
          buildPrompt: () => 'read the big output',
        });
        return loop.runStep(context);
      },
    };
    const { fixtures, steps } = runtime(foldingBigScreen(() => variant), { agents: { default: { executor, model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(5);
    // The first look listed the sidebar in full; the second look folded it
    // against the opening screen, at whatever revision the settling
    // captures minted.
    const first = loopCalls[1]!.lastToolResult;
    expect(first).toContain('#n901 link "Item 1"');
    expect(first).not.toContain('unchanged since revision');
    const folded = loopCalls[2]!.lastToolResult;
    expect(folded).toContain('navigation "Sidebar" (12 nodes inside, unchanged since revision');
    // The retry cut the opening screen's tail, sidebar included: the
    // opening prompt carries no screen here, so the cut shows in the
    // observe result the retried request carries.
    expect(loopCalls[3]!.lastToolResult).toContain("more characters cut: the request exceeded the model's context window");
    expect(loopCalls[3]!.lastToolResult).not.toContain('link "Item 1"');
    // The next look lists the sidebar in full instead of folding against a
    // screen the model no longer holds whole.
    const next = loopCalls[4]!.lastToolResult;
    expect(next).toMatch(/Current screen \(revision b\d+/);
    expect(next).toContain('#n901 link "Item 1"');
    expect(next).not.toContain('unchanged since revision');
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
    expect(step.metrics?.modelCalls).toBe(4);
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

  it('gives tools built after two concurrent runs on one context their own first screen', async () => {
    let after: string | undefined;
    // Content-scripted, not turn-scripted: the two runs interleave, so no
    // absolute turn belongs to either loop.
    const model = installFakeLoopModel((call) => {
      if (call.lastToolResult === '') return [{ toolName: 'observe', input: {} }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'loop read the sidebar' } }];
    });
    const loop = () =>
      createToolLoopExecutor({
        name: 'custom-loop',
        tools: (context) => createGrammarTools(context),
        buildPrompt: () => 'read the big output',
      });
    // The review's repro: one custom runStep that runs two loops against the
    // same step context at once, then builds grammar tools from it. The
    // screen never changes, so a presenter left bound by either run would
    // answer the later look with the screen that run already showed.
    const executor: StepExecutor = {
      name: 'two-concurrent-loops',
      runStep: async (context) => {
        const [first] = await Promise.all([loop().runStep(context), loop().runStep(context)]);
        after = await observeDirectly(context);
        return first!;
      },
    };
    const { fixtures, steps } = runtime(foldingBigScreen(() => 0), { agents: { default: { executor, model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(4);
    // Each loop's first look lists the sidebar in full, as its own first screen.
    for (const call of loopCalls) {
      if (call.lastToolResult === '') continue;
      expect(call.lastToolResult).toMatch(/Current screen \(revision b\d+/);
      expect(call.lastToolResult).toContain('#n901 link "Item 1"');
      expect(call.lastToolResult).not.toContain('unchanged since revision');
    }
    // The tools built after both runs get their own first screen, instead of
    // reporting the screen the run that ended last already showed.
    expect(after).toMatch(/Current screen \(revision b\d+/);
    expect(after).toContain('#n901 link "Item 1"');
    expect(after).not.toContain('unchanged since revision');
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
  });

  it('gives a toolset built between two staggered concurrent runs the live run\'s presenter', async () => {
    let variant = 0;
    let resolveADone: (() => void) | undefined;
    let resolveBSawNew: (() => void) | undefined;
    const aDone = new Promise<void>((resolve) => {
      resolveADone = resolve;
    });
    const bSawNew = new Promise<void>((resolve) => {
      resolveBSawNew = resolve;
    });
    let releaseB = false;
    let bTurns = 0;
    // Content-scripted, not turn-scripted: the two runs interleave, so the
    // build prompt tells them apart. Loop A observes once and ends; loop B
    // keeps observing until the test releases it, so A ends while B is
    // still live and the toolset is built in between.
    const model = installFakeLoopModel((call) => {
      if (call.prompt.includes('loop A')) {
        if (call.lastToolResult === '') return [{ toolName: 'observe', input: {} }];
        // The screen changes once A has seen it whole: B's presenter then
        // holds the new screen while A's still holds the old one, so which
        // presenter the toolset got is visible in its first look.
        variant = 1;
        resolveADone?.();
        return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'loop A read the sidebar' } }];
      }
      bTurns += 1;
      if (call.lastToolResult.includes('v1 row')) resolveBSawNew?.();
      if (releaseB || bTurns > 50) return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'loop B read the sidebar' } }];
      return [{ toolName: 'observe', input: {} }];
    });
    const loop = (label: string) =>
      createToolLoopExecutor({
        name: 'custom-loop',
        tools: (context) => createGrammarTools(context),
        buildPrompt: () => `read the big output, ${label}`,
      });
    let stepContext: StepExecutorContext | undefined;
    let after: string | undefined;
    const executor: StepExecutor = {
      name: 'two-staggered-loops',
      runStep: async (context) => {
        stepContext = context;
        const [first] = await Promise.all([loop('loop A').runStep(context), loop('loop B').runStep(context)]);
        return first!;
      },
    };
    const { fixtures, steps } = runtime(foldingBigScreen(() => variant), { agents: { default: { executor, model } } });

    const run = fixtures.agent.act('read the big output');
    await aDone;
    await bSawNew;
    // Loop A ended while loop B is still live: the toolset built now reads
    // the live run's presenter, whose screen is the new one, so its first
    // look reports the screen unchanged instead of listing it in full
    // against the screen the ended run last showed.
    after = await observeDirectly(stepContext!);
    releaseB = true;
    await run;

    expect(after).toContain('Screen unchanged since revision');
    expect(after).not.toContain('Current screen');
    const step = steps.all()[0]!;
    expect(step.status).toBe('passed');
  });

  it('gives a loop nested inside another loop\'s tool its own first screen, and the outer loop keeps its own', async () => {
    let outerContext: StepExecutorContext | undefined;
    const inner = () =>
      createToolLoopExecutor({
        name: 'inner-loop',
        tools: (context) => createGrammarTools(context),
        buildPrompt: () => 'read the big output',
      });
    // A project tool that runs a second loop against the same step context,
    // as a custom executor that delegates part of a step would.
    const nest = defineTool(
      {
        inputSchema: z.object({}),
        execute: async () => {
          const verdict = await inner().runStep(outerContext!);
          return `nested loop ${verdict.status}`;
        },
      },
      { mutates: false },
    );
    const model = installFakeLoopModel((call) => {
      // The inner loop offers no `nest` tool, so the tool names tell the
      // loops apart whatever order their turns interleave in.
      if (call.toolNames.includes('nest')) {
        if (call.lastToolResult === '') return [{ toolName: 'nest', input: {} }];
        if (call.lastToolResult.includes('nested loop passed')) return [{ toolName: 'observe', input: {} }];
        return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'outer read the sidebar after the nested run' } }];
      }
      if (call.lastToolResult === '') return [{ toolName: 'observe', input: {} }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'inner read the sidebar' } }];
    });
    const outer = createToolLoopExecutor({
      name: 'outer-loop',
      tools: (context, helpers) => ({
        ...projectTools(context, { nest }),
        ...createGrammarTools(context, { guard: helpers.guard }),
      }),
      buildPrompt: () => 'read the big output',
    });
    const executor: StepExecutor = {
      name: 'nested-loops',
      runStep: async (context) => {
        outerContext = context;
        return outer.runStep(context);
      },
    };
    const { fixtures, steps } = runtime(foldingBigScreen(() => 0), { agents: { default: { executor, model } } });

    await fixtures.agent.act('read the big output');

    expect(loopCalls).toHaveLength(5);
    // The inner loop's first look and the outer loop's look after the nested
    // run each list the sidebar in full, as their own first screens: the
    // nested run never touched the outer presenter's screen, and the outer
    // look never reuses the inner run's. A run that reused the outer
    // binding instead of binding fresh would answer the outer look with the
    // screen the inner run already showed.
    for (const call of loopCalls) {
      if (call.lastToolResult === '' || call.lastToolResult.includes('nested loop passed')) continue;
      expect(call.lastToolResult).toMatch(/Current screen \(revision b\d+/);
      expect(call.lastToolResult).toContain('#n901 link "Item 1"');
      expect(call.lastToolResult).not.toContain('unchanged since revision');
    }
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

describe('built-in agent opening prompts', () => {
  it.each(['act', 'assert'] as const)(
    'gives each of two overlapping built-in %s runs its own opening prompt',
    async (kind) => {
      let variant = 0;
      const seenFirst = new Set<string>();
      let resolveBothOpened: (() => void) | undefined;
      const bothOpened = new Promise<void>((resolve) => {
        resolveBothOpened = resolve;
      });
      let lTurns = 0;
      // The system line tells the runs apart: each run's model calls carry
      // its own. Loop E starts first and completes once it has opened; loop
      // L starts second and keeps observing. The first look returns a
      // sidebar of plain text, so the act run's opening look finds no
      // interactive node and looks a second time, after L has opened: if
      // E read its presenter after its first look instead of before it,
      // E's opening renders through L's presenter and overwrites L's fold
      // record with E's revision. The screen then changes and L observes
      // it again; that look folds the sidebar against the revision L's
      // opening prompt showed, the one L's model holds.
      const model = installFakeLoopModel((call) => {
        if (call.system.includes('Loop E')) {
          if (call.lastToolResult === '') seenFirst.add('E');
          if (seenFirst.has('E') && seenFirst.has('L')) resolveBothOpened?.();
          return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the sidebar' } }];
        }
        lTurns += 1;
        if (call.lastToolResult === '') {
          seenFirst.add('L');
          if (seenFirst.has('E') && seenFirst.has('L')) resolveBothOpened?.();
          return [{ toolName: 'observe', input: {} }];
        }
        if (variant === 1 && call.lastToolResult.includes('v1 row') && call.lastToolResult.includes('unchanged since revision')) {
          return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the sidebar' } }];
        }
        if (lTurns > 50) return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the sidebar' } }];
        return [{ toolName: 'observe', input: {} }];
      });
      const executor: StepExecutor = {
        name: 'two-built-in-agents',
        runStep: async (context) => {
          const agentE = createBuiltInAgent({ system: 'Loop E.' });
          const agentL = createBuiltInAgent({ system: 'Loop L.' });
          const runs = Promise.all([agentE.runStep(context), agentL.runStep(context)]);
          await bothOpened;
          variant = 1;
          const [first] = await runs;
          return first!;
        },
      };
      const { fixtures, steps } = runtime(foldingStillScreen(() => variant), { agents: { default: { executor, model } } });

      await fixtures.agent[kind]('read the big output');

      const lCalls = loopCalls.filter((call) => call.system.includes('Loop L'));
      const eCalls = loopCalls.filter((call) => call.system.includes('Loop E'));
      expect(lCalls.length).toBeGreaterThan(0);
      expect(eCalls).toHaveLength(1);
      const lOpening = lCalls[0]!.prompt;
      const eOpening = eCalls[0]!.prompt;
      // Each opening prompt lists the sidebar in full, as its own first
      // screen, instead of reporting the screen the other run already showed.
      // The act run's opening look is its second, pixels, look, so it lists
      // the sidebar as links; the assert run's only look is the first, so
      // its opening lists it as text.
      expect(lOpening).toContain('Current screen (revision');
      expect(lOpening).toContain('#n901 link "Item 1"');
      expect(lOpening).not.toContain('unchanged since revision');
      expect(eOpening).toContain('Current screen (revision');
      expect(eOpening).toContain(kind === 'act' ? '#n901 link "Item 1"' : '#n901 text "Item 1"');
      expect(eOpening).not.toContain('unchanged since revision');
      const lRevision = /Current screen \(revision (b\d+)/.exec(lOpening)?.[1];
      const eRevision = /Current screen \(revision (b\d+)/.exec(eOpening)?.[1];
      expect(lRevision).toMatch(/^b\d+$/);
      expect(eRevision).toMatch(/^b\d+$/);
      expect(eRevision).not.toBe(lRevision);
      if (kind === 'act') {
        // The first run's opening look came after the second run's: its
        // render could overwrite the second run's fold record. If this
        // ever fails, the interleaving the test relies on has changed.
        expect(Number(eRevision!.slice(1))).toBeGreaterThan(Number(lRevision!.slice(1)));
      }
      // The look after the screen changed folds the sidebar against the
      // revision L's opening prompt showed, the one L's model holds.
      const folded = lCalls.find(
        (call) => call.lastToolResult.includes('v1 row') && call.lastToolResult.includes('unchanged since revision'),
      );
      expect(folded).toBeDefined();
      const foldRevision = /unchanged since revision (b\d+)/.exec(folded!.lastToolResult)?.[1];
      expect(foldRevision).toBe(lRevision);
      const step = steps.all()[0]!;
      expect(step.status).toBe('passed');
    },
  );
});
