import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SemanticNode } from '@e2e-dev/core/lib/engine/surface';
import { SecretLedger } from '@e2e-dev/core/lib/internal/redact';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import type { ScriptedNode } from '../helpers/scripted-scene.ts';
import { resolveConfig } from '../../src/config/resolve-run.ts';
import { SessionHost } from '../../src/mcp/session.ts';
import { describeLocate, locateQuery } from '../../src/session-tools/catalog.ts';
import type { McpToolResult } from '../../src/session-tools/tools.ts';

function node(role: string, name: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id: 'l1', revision: 'l1' }, role, name, ...extra };
}

/** A session with no secret registered renders every node as it is. */
const keep = (text: string): string => text;

describe('locateQuery', () => {
  it('builds each query kind and the matching screen call, carrying exact: false into both', () => {
    const query = locateQuery({ role: 'button', name: 'Save' });
    expect(query.code).toBe('screen.getByRole("button", "Save")');
    expect(query.expression).toMatchObject({ kind: 'query', query: { kind: 'role', name: { kind: 'string', value: 'Save', exact: true } } });
    const text = locateQuery({ text: 'sign', exact: false });
    expect(text.code).toBe('screen.getByText("sign", { exact: false })');
    expect(text.expression).toMatchObject({ query: { kind: 'text', value: { exact: false } } });
    expect(locateQuery({ label: 'Email' }).code).toBe('screen.getByLabel("Email")');
    expect(locateQuery({ placeholder: 'you@example.test' }).code).toBe('screen.getByPlaceholder("you@example.test")');
    expect(locateQuery({ testId: 'items' }).code).toBe('screen.getByTestId("items")');
  });

  it('rejects zero or several query kinds and a name without a role', () => {
    expect(() => locateQuery({})).toThrow(/exactly one of role, text, label, placeholder, or testId/);
    expect(() => locateQuery({ role: 'button', text: 'Save' })).toThrow(/exactly one/);
    expect(() => locateQuery({ text: 'Save', name: 'Save' })).toThrow(/name only narrows a role query/);
  });
});

describe('describeLocate', () => {
  it('tells the agent which test outcome the locator would have', () => {
    const query = locateQuery({ role: 'button', name: 'Save' });
    expect(describeLocate(query, 1, [node('button', 'Save')], { redact: keep, redactCut: keep })).toBe(
      '1 node matches getByRole("button", name: "Save").\nUse: screen.getByRole("button", "Save")\n- button "Save"',
    );
    expect(describeLocate(query, 0, [], { redact: keep, redactCut: keep })).toContain('LOCATOR_NOT_FOUND');
    const ambiguous = describeLocate(query, 12, [node('button', 'Save', { states: { disabled: true } })], { redact: keep, redactCut: keep });
    expect(ambiguous).toContain('12 nodes match');
    expect(ambiguous).toContain('LOCATOR_AMBIGUOUS');
    expect(ambiguous).toContain('- button "Save" [disabled]');
    expect(ambiguous).toContain('- and 11 more');
  });

  it('on no match for a role name, points at the text a status shows in observe instead of retrying it as a name', () => {
    const none = { redact: keep, redactCut: keep };
    const exact = describeLocate(locateQuery({ role: 'status', name: 'Saved.' }), 0, [], none);
    expect(exact).toContain('LOCATOR_NOT_FOUND');
    expect(exact).toContain('screen.getByRole("status").filter({ hasText: "Saved." })');
    expect(exact).toContain('screen.getByText("Saved.")');
    expect(exact).toContain('observe shows a status by its text');
    expect(exact).not.toContain('Check the accessible name in the observation');
    const loose = describeLocate(locateQuery({ role: 'status', name: 'Saved.', exact: false }), 0, [], none);
    expect(loose).toContain('screen.getByRole("status").filter({ hasText: "Saved." })');
    expect(loose).toContain('screen.getByText("Saved.", { exact: false })');
    expect(loose).not.toContain('loosen');
    expect(describeLocate(locateQuery({ role: 'alert', name: 'Failed' }), 0, [], none)).toContain('observe shows an alert by its text');
    expect(describeLocate(locateQuery({ role: 'listitem', name: 'Milk' }), 0, [], none)).toContain('observe shows a listitem by its text');
    const button = describeLocate(locateQuery({ role: 'button', name: 'Submitt' }), 0, [], none);
    expect(button).toContain('Check the accessible name in the observation');
    expect(button).not.toContain('hasText');
  });

  it('on no match, offers exact: false only when the query is still exact', () => {
    const none = { redact: keep, redactCut: keep };
    expect(describeLocate(locateQuery({ text: 'Saved' }), 0, [], none)).toContain('loosen the match with exact: false');
    expect(describeLocate(locateQuery({ text: 'Saved', exact: false }), 0, [], none)).not.toContain('loosen');
  });

  it('never shows the value of a secure node', () => {
    const query = locateQuery({ label: 'Password' });
    const text = describeLocate(query, 1, [node('textbox', 'Password', { value: 'hunter2', states: { secure: true } })], { redact: keep, redactCut: keep });
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[secure]');
  });

  it('renders a registered secret in a plain node by its name, never the plaintext', () => {
    const ledger = new SecretLedger([['apiKey', 'sk-live-SUPERSECRET-0000']]);
    const query = locateQuery({ label: 'API key' });
    const filled = node('textbox', 'API key', { value: 'sk-live-SUPERSECRET-0000' });
    const echoed = node('status', 'Saved key', { text: 'Saved sk-live-SUPERSECRET-0000' });
    const text = describeLocate(query, 2, [filled, echoed], ledger);
    expect(text).not.toContain('sk-live-SUPERSECRET-0000');
    expect(text).toContain('- textbox "API key" value "<secret:apiKey>"');
    expect(text).toContain('- status "Saved key" text "Saved <secret:apiKey>"');
  });
});

describe('session screen presenter', () => {
  let dir: string;
  let host: SessionHost | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-session-fold-'));
  });

  afterEach(async () => {
    await host?.closeAll('test done');
    host = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  /** The text of a tool result's text items. */
  const textOf = (result: McpToolResult): string =>
    result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');

  it('folds a large unchanged subtree in an action result from a session it opened', { timeout: 60_000 }, async () => {
    // An orders page: a sidebar of 12 links beside a main that changes
    // wholesale when one order opens, so the tap's screen goes out whole
    // with the sidebar folded to one line.
    const sidebar: ScriptedNode = {
      id: 'sidebar',
      role: 'navigation',
      name: 'Sidebar',
      children: Array.from({ length: 12 }, (_, i) => ({ id: `item-${String(i + 1)}`, role: 'link', name: `Item ${String(i + 1)}` })),
    };
    const details: ScriptedNode[] = [
      { id: 'detail-heading', role: 'heading', name: 'Order 42' },
      { id: 'detail-total', role: 'text', name: 'Total $12' },
      { id: 'detail-placed', role: 'text', name: 'Placed yesterday' },
      { id: 'detail-refund', role: 'button', name: 'Refund' },
      { id: 'detail-ship', role: 'button', name: 'Ship' },
      { id: 'detail-print', role: 'button', name: 'Print' },
      { id: 'detail-archive', role: 'button', name: 'Archive' },
      { id: 'detail-note', role: 'text', name: 'Ships in 2 days' },
      { id: 'detail-history', role: 'link', name: 'Order history' },
      { id: 'detail-back', role: 'link', name: 'Back to orders' },
    ];
    const main: ScriptedNode = {
      id: 'main',
      role: 'main',
      name: 'Order list',
      children: [
        { id: 'list-heading', role: 'heading', name: 'Orders' },
        {
          id: 'order-1',
          role: 'button',
          name: 'Order 1',
          on: () => {
            main.name = 'Order details';
            main.children = details;
          },
        },
        { id: 'order-2', role: 'button', name: 'Order 2' },
      ],
    };
    const fake = createFakeEngine({ scene: () => [sidebar, main] });
    const sessionHost = new SessionHost({
      locateConfig: (requested) => path.join(dir, requested ?? 'e2e.config.ts'),
      loadConfig: async (configPath) => ({
        ...resolveConfig(
          {
            targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine, app: FAKE_APP }],
            credentials: { admin: { username: 'admin', password: 'kiosk-pw' } },
          } as never,
          { projectRoot: dir, env: {}, configPath },
        ),
        configPath,
      }),
      loadEngineConfig: async () => {
        throw new Error('this test opens no engine session');
      },
      env: {},
      headed: false,
      log: () => undefined,
    });
    host = sessionHost;
    const opened = await sessionHost.open({});
    const sessionMatch = /^Session (\S+) open/.exec(opened);
    if (sessionMatch === null) throw new Error('open text names no session');
    const id = sessionMatch[1]!;
    const revisionMatch = /Current screen \(revision (b\d+)/.exec(opened);
    if (revisionMatch === null) throw new Error('open text shows no first screen');
    const firstRevision = revisionMatch[1]!;
    // The first screen lists the sidebar whole: no fold line yet.
    expect(opened).toContain('link "Item 1"');
    expect(opened).not.toContain('same as revision');
    const tapped = await sessionHost.call(id, 'tap', { target: 'order-1' }, { signal: new AbortController().signal });
    const text = textOf(tapped);
    expect(text).toContain('Tapped #order-1.');
    // The session's own presenter folds: a plain presenter would list the
    // sidebar in full here instead.
    expect(text).toContain(`(12 nodes inside, same as revision ${firstRevision})`);
    expect(text).not.toContain('link "Item 1"');
    expect(text).toContain('heading "Order 42"');
    await sessionHost.close('done', id);
  });
});
