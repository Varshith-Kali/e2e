import type { Tool, ToolSet } from 'ai';
import { z } from 'zod';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadAiSdk } from '@e2e-dev/core/lib/agent/ai-sdk';
import type { ExecutorObservation, StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';
import { createGrammarTools } from '@e2e-dev/core/lib/agent/primitives';
import { ScreenPresenter } from '@e2e-dev/core/lib/agent/screen-update';
import { TestError } from '@e2e-dev/core/lib/internal/errors';
import { createSessionCatalog } from '../../src/session-tools/catalog.ts';
import { createSessionScreenPresenter } from '../../src/session-tools/screen.ts';
import { catalogLine, describeToolDetail, errorResult, invokeTool, resultFromOutput, toolJsonSchema, type McpToolResult } from '../../src/session-tools/tools.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';

const extra = { signal: new AbortController().signal };

// The catalog renders synchronously off the loaded SDK, as it does after the session host primes it.
beforeAll(() => loadAiSdk());

const tap: ToolSet[string] = {
  description: 'Tap or click one node. The result waits for the effect and reports what changed.',
  inputSchema: z.object({ target: z.string().min(1).describe('Node id'), times: z.number().int().optional() }),
  execute: async (input: { target: string }) => `Tapped #${input.target}.`,
};

describe('catalogLine', () => {
  it('shows the name, the argument names with optional ones marked, and the first sentence', () => {
    expect(catalogLine('tap', tap, false)).toBe('- tap {target, times?}: Tap or click one node.');
  });

  it('does not end the sentence at an abbreviation and bounds a run-on sentence', () => {
    const press: ToolSet[string] = { description: 'Send one key (e.g. "Enter", "Escape", "Tab") to one node. More text.', inputSchema: z.object({ key: z.string() }), execute: async () => 'ok' };
    expect(catalogLine('press', press, false)).toBe('- press {key}: Send one key (e.g. "Enter", "Escape", "Tab") to one node.');
    const long: ToolSet[string] = { description: `${'word '.repeat(60)}end`, inputSchema: z.object({}), execute: async () => 'ok' };
    const line = catalogLine('long', long, false);
    expect(line.length).toBeLessThan(200);
    expect(line.endsWith('…')).toBe(true);
  });

  it('redacts a secret that spans the catalog sentence cutoff', () => {
    const secret = 'private. part is not for the catalog';
    const tool = { ...tap, description: `Uses ${secret}. More details.` };
    expect(catalogLine('tap', tool, false, (value) => value.replaceAll(secret, '<secret:token>')))
      .toBe('- tap {target, times?}: Uses <secret:token>.');
  });
});

describe('describeToolDetail and toolJsonSchema', () => {
  it('renders the full description and the JSON Schema without the draft marker', () => {
    const detail = describeToolDetail('tap', tap, false);
    expect(detail).toContain('Tap or click one node. The result waits for the effect and reports what changed.');
    expect(detail).toContain('Arguments (JSON Schema):');
    expect(detail).not.toContain('$schema');
    expect(toolJsonSchema(tap)).toMatchObject({
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string', description: 'Node id' }, times: { type: 'integer' } },
    });
  });
});

describe('invokeTool', () => {
  it('does not run a tool whose request was cancelled while queued', async () => {
    const execute = vi.fn(async () => 'never');
    const reason = new Error('cancelled before dispatch');
    await expect(invokeTool('tap', { ...tap, execute }, { target: 'n4' }, { signal: AbortSignal.abort(reason) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not run a tool cancelled while its async schema validates', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled during validation');
    const execute = vi.fn(async () => 'never');
    const inputSchema = z.object({ target: z.string() }).superRefine(async () => {
      controller.abort(reason);
    });
    await expect(invokeTool('tap', { ...tap, inputSchema, execute }, { target: 'n4' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates the arguments against the tool schema and runs the tool', async () => {
    await expect(invokeTool('tap', tap, { target: 'n4' }, extra)).resolves.toEqual({ content: [{ type: 'text', text: 'Tapped #n4.' }] });
  });

  it('rejects wrong arguments before the tool runs, naming the field and pointing at tools', async () => {
    let ran = false;
    const guarded: ToolSet[string] = {
      ...tap,
      execute: async () => {
        ran = true;
        return 'never';
      },
    };
    await expect(invokeTool('tap', guarded, { target: 5 }, extra)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(/^call tap: target: .*; tools \{tool: "tap"\} shows its arguments$/),
    });
    await expect(invokeTool('tap', guarded, {}, extra)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(ran).toBe(false);
  });

  it('refuses an argument a grammar tool does not declare, before anything is dispatched', async () => {
    const { context, dispatched } = fakeExecutorContext();
    const grammar = createGrammarTools(context);
    await expect(invokeTool('tap', grammar['tap']!, { target: 'n4', force: true }, extra)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'call tap: Unrecognized key: "force"; tools {tool: "tap"} shows its arguments',
    });
    expect(dispatched).toEqual([]);
  });

  it("refuses an argument the session catalog's observe and locate do not declare", async () => {
    const { context, dispatched } = fakeExecutorContext();
    const resolveNow = vi.fn(async () => []);
    const { tools } = createSessionCatalog({
      context,
      screen: new ScreenPresenter(),
      locator: { resolveNow } as never,
      session: {} as never,
      tools: {},
      redaction: { redact: (text) => text, redactCut: (text) => text },
      projectRoot: '/project',
      attemptDir: '/project/.e2e/results/attempt',
      recorder: undefined,
      warn: () => undefined,
    });
    await expect(invokeTool('observe', tools['observe']!, { verbose: true }, extra)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'call observe: Unrecognized key: "verbose"; tools {tool: "observe"} shows its arguments',
    });
    await expect(invokeTool('locate', tools['locate']!, { role: 'button', selector: '#save' }, extra)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'call locate: Unrecognized key: "selector"; tools {tool: "locate"} shows its arguments',
    });
    expect(dispatched).toEqual([]);
    expect(resolveNow).not.toHaveBeenCalled();
  });

  it('lets a tool failure propagate with its code, for the host to render', async () => {
    const failing: ToolSet[string] = {
      description: 'Capture a fresh observation.',
      inputSchema: z.object({}),
      execute: async () => {
        throw new TestError('LOCATOR_NOT_FOUND', 'no observation has been captured yet');
      },
    };
    await expect(invokeTool('observe', failing, {}, extra)).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
  });

  it('refuses a tool without an execute function', async () => {
    const inert: ToolSet[string] = { description: 'x', inputSchema: z.object({}) };
    await expect(invokeTool('inert', inert, {}, extra)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});

describe('resultFromOutput', () => {
  const plain: Tool = { description: 'x', inputSchema: z.object({}) };

  it('passes text through and serializes structured output as JSON', async () => {
    expect(await resultFromOutput(plain, 'Done.')).toEqual({ content: [{ type: 'text', text: 'Done.' }] });
    expect(await resultFromOutput(plain, { ok: true })).toEqual({ content: [{ type: 'text', text: '{\n  "ok": true\n}' }] });
    expect(await resultFromOutput(plain, undefined)).toEqual({ content: [{ type: 'text', text: 'Done.' }] });
  });

  it('renders a toModelOutput file part as an image, the way the device screenshot tool does', async () => {
    const screenshot: Tool = {
      ...plain,
      toModelOutput: ({ output }) =>
        (output as { png?: string }).png === undefined
          ? { type: 'text', value: 'Screenshot withheld: UNSUPPORTED_CAPABILITY' }
          : { type: 'content', value: [{ type: 'file', data: { type: 'data', data: (output as { png: string }).png }, mediaType: 'image/png' }] },
    };
    expect(await resultFromOutput(screenshot, { png: 'AAAA' })).toEqual({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    expect(await resultFromOutput(screenshot, { withheld: 'UNSUPPORTED_CAPABILITY' })).toEqual({
      content: [{ type: 'text', text: 'Screenshot withheld: UNSUPPORTED_CAPABILITY' }],
    });
  });

  it('hands the call arguments to a renderer that reads its input', async () => {
    const echo: Tool = {
      description: 'x',
      inputSchema: z.object({ label: z.string() }),
      toModelOutput: ({ input, output }) => ({ type: 'text', value: `${(input as { label: string }).label}: ${String(output)}` }),
    };
    expect(await resultFromOutput(echo, 42, { label: 'answer' })).toEqual({ content: [{ type: 'text', text: 'answer: 42' }] });
  });

  it('renders string outputs with the custom renderer before passing them through', async () => {
    const rendered: Tool = {
      ...plain,
      toModelOutput: async ({ output }) => ({ type: 'text', value: `formatted: ${String(output)}` }),
    };
    expect(await resultFromOutput(rendered, 'raw string')).toEqual({ content: [{ type: 'text', text: 'formatted: raw string' }] });
  });

  it('preserves model error outputs as MCP errors', async () => {
    const errorText: Tool = { ...plain, toModelOutput: () => ({ type: 'error-text', value: 'not available' }) };
    const errorJson: Tool = { ...plain, toModelOutput: () => ({ type: 'error-json', value: { reason: 'not available' } }) };
    expect(await resultFromOutput(errorText, 'raw string')).toEqual({ content: [{ type: 'text', text: 'not available' }], isError: true });
    expect(await resultFromOutput(errorJson, { reason: 'not available' })).toEqual({ content: [{ type: 'text', text: '{\n  "reason": "not available"\n}' }], isError: true });
  });
});

describe('errorResult', () => {
  it('prefixes runner errors with their code and leaves foreign errors as their message', () => {
    expect(errorResult(new TestError('ACTION_FAILED', 'covered'))).toEqual({ content: [{ type: 'text', text: 'ACTION_FAILED: covered' }], isError: true });
    expect(errorResult(new Error('boom'))).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
  });
});

describe('session catalog folding', () => {
  /** A sidebar of 12 links under a navigation node, and a main that changes wholesale. */
  const sidebar = [
    ' #n2 navigation "Sidebar"',
    ...Array.from({ length: 12 }, (_, i) => `  #n${String(i + 3)} link "Item ${String(i + 1)}"`),
  ];
  const mainList = [
    ' #n20 main "Order list"',
    '  #n21 heading "Orders"',
    '  #n22 button "Order 1"',
    '  #n23 button "Order 2"',
  ];
  const mainDetails = [
    ' #n20 main "Order details"',
    '  #n30 heading "Order 42"',
    '  #n31 text "Total $12"',
    '  #n32 text "Placed yesterday"',
    '  #n33 button "Refund"',
    '  #n34 button "Ship"',
    '  #n35 button "Print"',
    '  #n36 button "Archive"',
    '  #n37 link "Back to orders"',
  ];
  const observation = (revision: string, main: readonly string[]): ExecutorObservation => ({
    revision,
    text: ['#n1 document "Orders"', ...sidebar, ...main].join('\n'),
    truncated: false,
    viewport: { width: 1280, height: 720 },
  });
  const textOf = (result: McpToolResult): string =>
    result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');

  it('folds a large unchanged subtree in an action result, and observe returns it whole again', async () => {
    const { context } = fakeExecutorContext();
    const observations = [observation('b1', mainList), observation('b2', mainDetails), observation('b2', mainDetails)];
    let calls = 0;
    // The shared session presenter: the one both session kinds build, with folding on.
    const scripted: StepExecutorContext = {
      ...context,
      observe: (async () => observations[Math.min(calls++, observations.length - 1)]!) as StepExecutorContext['observe'],
      actions: { ...context.actions, tap: (async () => undefined) as StepExecutorContext['actions']['tap'] },
    };
    const { tools } = createSessionCatalog({
      context: scripted,
      screen: createSessionScreenPresenter(),
      locator: { resolveNow: async () => [] } as never,
      session: {} as never,
      tools: {},
      redaction: { redact: (text) => text, redactCut: (text) => text },
      projectRoot: '/project',
      attemptDir: '/project/.e2e/results/attempt',
      recorder: undefined,
      warn: () => undefined,
    });
    const opened = await invokeTool('observe', tools['observe']!, {}, extra);
    expect(textOf(opened)).toContain('#n3 link "Item 1"');
    expect(textOf(opened)).not.toContain('same as revision');
    const tapped = await invokeTool('tap', tools['tap']!, { target: 'n22' }, extra);
    const tappedText = textOf(tapped);
    expect(tappedText).toContain('Tapped #n22.');
    expect(tappedText).toContain(' #n2 navigation "Sidebar" (12 nodes inside, same as revision b1)');
    expect(tappedText).not.toContain('#n3 link "Item 1"');
    const again = await invokeTool('observe', tools['observe']!, {}, extra);
    expect(textOf(again)).toContain('#n3 link "Item 1"');
    expect(textOf(again)).not.toContain('same as revision');
  });
});
