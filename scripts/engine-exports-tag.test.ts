import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { engineImportProblems, engineImports, fixtureExportsAt, resolveEntryExports, resolveModule, resolveWorkspaceSpecifier, subpathEntryFile, tagExportsAt, type EngineImportCheck, type EngineImportMap, type ImportKind } from './engine-exports.ts';
describe('exportedNames and resolveEntryExports', () => {
  it('reads named exports, aliases, declarations, and export-star chains', () => {
    const files = new Map([
      [
        'src/engine/index.ts',
        `export { stepTimeout } from './timing.ts';\nexport { EngineError as EngineErr } from './errors.ts';\nexport type * from './contract.ts';\nexport interface Local { x: string }\n`,
      ],
      ['src/engine/timing.ts', `export function stepTimeout(): void {}\n`],
      ['src/engine/errors.ts', `export class EngineError extends Error {}\n`],
      ['src/engine/contract.ts', `export type NodeRef = string;\nexport * from './kinds.ts';\n`],
      ['src/engine/kinds.ts', `export type Kind = 'a';\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['EngineErr', 'stepTimeout']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), ['Kind', 'Local', 'NodeRef']);
  });

  it('does not count a type-star re-export as a value export', () => {
    const files = new Map([
      ['src/engine/index.ts', `export type * from './contract.ts';\nexport { parseKey } from './contract.ts';\n`],
      [
        'src/engine/contract.ts',
        `export function isKeyModifier(value: unknown): boolean { return false; }\nexport function parseKey(value: string): string { return value; }\nexport type KeyModifier = 'Shift';\nexport const KEY_MODIFIERS = ['Shift'] as const;\n`,
      ],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['parseKey']);
    // The functions and const reached through `export type *` are types
    // there, not values: a type-only import of one (for `typeof`) is
    // satisfied, a value import is not.
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), ['KEY_MODIFIERS', 'KeyModifier', 'isKeyModifier', 'parseKey']);
  });

  it('does not count a value export-star reached through a type-star as a value export', () => {
    const files = new Map([
      ['src/engine/index.ts', `export type * from './mid.ts';\n`],
      ['src/engine/mid.ts', `export * from './leaf.ts';\n`],
      ['src/engine/leaf.ts', `export function stepTimeout(): void {}\nexport type NodeRef = string;\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])], []);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), ['NodeRef', 'stepTimeout']);
  });

  it('exports only the namespace name for export star as', () => {
    const files = new Map([
      ['src/engine/index.ts', `export * as engine from './engine.ts';\n`],
      ['src/engine/engine.ts', `export function stepTimeout(): void {}\nexport class EngineError extends Error {}\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['engine']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('reads a default export as the default name', () => {
    const files = new Map([
      ['src/engine/index.ts', `export default function makeEngine(): void {}\nexport function stepTimeout(): void {}\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['default', 'stepTimeout']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('does not pass default through an export star', () => {
    const files = new Map([
      ['src/engine/index.ts', `export * from './star.ts';\n`],
      ['src/engine/star.ts', `export default function d(): void {}\nexport const x = 1;\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['x']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('keeps the entry file default when it also stars another file', () => {
    const files = new Map([
      ['src/engine/index.ts', `export default function makeEngine(): void {}\nexport * from './star.ts';\n`],
      ['src/engine/star.ts', `export default function d(): void {}\nexport const x = 1;\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['default', 'x']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('reads a name exported as default', () => {
    const files = new Map([
      ['src/engine/index.ts', `function makeEngine(): void {}\nexport { makeEngine as default };\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['default']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('reads async functions and declare const enums as declarations', () => {    const files = new Map([
      [
        'src/engine/index.ts',
        `export async function runCheck(): Promise<void> {}\nexport declare const enum Mode { A = 'a' }\nexport declare function helper(): void;\n`,
      ],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['Mode', 'helper', 'runCheck']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), ['Mode']);
  });

  it('counts an interface plus a namespace of the same name as both a type and a value', () => {
    const files = new Map([
      [
        'src/types.ts',
        `export interface Foo { x: string }\nexport namespace Foo { export const bar = 'bar'; }\n`,
      ],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/types.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['Foo']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), ['Foo']);
  });

  it('throws when an entry file fails to parse', () => {
    assert.throws(() => resolveEntryExports(() => 'export const = ;\n', 'src/engine/index.ts'), /failed to parse/);
  });

  it('ignores a commented-out export', () => {
    const files = new Map([['src/engine/index.ts', `export function kept(): void {}\n// export function gone(): void {}\n`]]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['kept']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('reads names bound by a destructured export const', () => {
    const files = new Map([['src/collect/registry.ts', `export const { describe, beforeEach, afterEach } = test;\n`]]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/collect/registry.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['afterEach', 'beforeEach', 'describe']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('does not leak types nested inside an exported namespace', () => {
    const files = new Map([
      [
        'src/types.ts',
        `export namespace StandardSchemaV1 {\n  export interface Props { x: string }\n  export type Result = { ok: boolean };\n}\n`,
      ],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/types.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['StandardSchemaV1']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('ignores comments inside export lists', () => {
    const files = new Map([
      ['src/engine/index.ts', `export { stepTimeout /* the timeout */, EngineError } from './errors.ts';\n`],
      ['src/engine/errors.ts', `export function stepTimeout(): void {}\nexport class EngineError extends Error {}\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['EngineError', 'stepTimeout']);
  });

  it('answers undefined when an entry file cannot be read', () => {
    assert.equal(resolveEntryExports(() => undefined, 'src/engine/index.ts'), undefined);
  });

  it('resolves relative module specifiers', () => {
    assert.equal(resolveModule('packages/e2e/src/engine/index.ts', '../internal/time.ts'), 'packages/e2e/src/internal/time.ts');
    assert.equal(resolveModule('packages/e2e/src/engine/index.ts', './contract.ts'), 'packages/e2e/src/engine/contract.ts');
    assert.equal(resolveModule('packages/e2e/src/engine/index.ts', 'zod'), undefined);
  });

  it('reads the entry file off a sibling package.json', () => {
    const packageJson = JSON.stringify({ exports: { './engine': { types: './dist/engine/index.d.ts', default: './dist/engine/index.js' } } });
    assert.equal(subpathEntryFile(packageJson, 'packages/e2e', 'engine'), 'packages/e2e/src/engine/index.ts');
    assert.equal(subpathEntryFile('not json', 'packages/e2e', 'engine'), undefined);
    assert.equal(subpathEntryFile(packageJson, 'packages/e2e', 'missing'), undefined);
  });

  it('reads a wildcard entry off a sibling package.json', () => {
    const packageJson = JSON.stringify({ exports: { './lib/*': { types: './dist/*.d.ts', default: './dist/*.js' } } });
    assert.equal(subpathEntryFile(packageJson, 'packages/core', 'lib/agent/public'), 'packages/core/src/agent/public.ts');
    assert.equal(subpathEntryFile(packageJson, 'packages/core', 'lib/types'), 'packages/core/src/types.ts');
  });

  it('prefers the longest wildcard prefix, like Node', () => {
    // In insertion order the short key comes first; Node still picks
    // ./lib/agent/* for lib/agent/public, not ./lib/*.
    const packageJson = JSON.stringify({
      exports: {
        './lib/*': { types: './dist/lib/*.d.ts', default: './dist/lib/*.js' },
        './lib/agent/*': { types: './dist/agent/*.d.ts', default: './dist/agent/*.js' },
      },
    });
    assert.equal(subpathEntryFile(packageJson, 'packages/core', 'lib/agent/public'), 'packages/core/src/agent/public.ts');
  });

  it('does not resolve a subpath the wildcard key is too short for', () => {
    // ./lib/ is shorter than ./lib/*, so Node does not match it, and it
    // must not resolve to src/.ts.
    const packageJson = JSON.stringify({ exports: { './lib/*': { types: './dist/*.d.ts', default: './dist/*.js' } } });
    assert.equal(subpathEntryFile(packageJson, 'packages/core', 'lib/'), undefined);
  });

  it('substitutes every star in a wildcard target', () => {
    const packageJson = JSON.stringify({ exports: { './multi/*': { types: './dist/*-*.d.ts', default: './dist/*-*.js' } } });
    assert.equal(subpathEntryFile(packageJson, 'packages/core', 'multi/x-y'), 'packages/core/src/x-y-x-y.ts');
  });

  it('reads a nested import condition types target', () => {
    // resolve.exports reads a `types` target nested under `import`; the
    // hand-written matching could not, and reported the entry unverifiable.
    const packageJson = JSON.stringify({ exports: { './i': { import: { types: './dist/i.d.ts', default: './dist/i.js' } } } });
    assert.equal(subpathEntryFile(packageJson, 'packages/e2e', 'i'), 'packages/e2e/src/i.ts');
  });

  it('reads the bare entry off a condition-sugar exports map', () => {
    // An `exports` object with no subpath keys is the condition map for
    // `.`, and resolve.exports reads it that way.
    const packageJson = JSON.stringify({ exports: { types: './dist/index.d.ts', default: './dist/index.js' } });
    assert.equal(subpathEntryFile(packageJson, 'packages/e2e', ''), 'packages/e2e/src/index.ts');
    assert.equal(subpathEntryFile(packageJson, 'packages/e2e', 'engine'), undefined);
  });

  it('does not read a types target listed after default', () => {
    // Node resolves conditions in key order, so `default` first wins
    // even when `types` is present: the entry has no reachable types
    // target, and stays unverifiable rather than reading the JS file.
    const packageJson = JSON.stringify({ exports: { './engine': { default: './dist/engine/index.js', types: './dist/engine/index.d.ts' } } });
    assert.equal(subpathEntryFile(packageJson, 'packages/e2e', 'engine'), undefined);
  });

  it('resolves a wildcard target with no star as-is, like Node', () => {
    // A pattern target without `*` names one file for every subpath:
    // Node resolves it as-is, so the check reads that entry file.
    const packageJson = JSON.stringify({ exports: { './lib/*': { types: './dist/index.d.ts', default: './dist/index.js' } } });
    assert.equal(subpathEntryFile(packageJson, 'packages/core', 'lib/foo'), 'packages/core/src/index.ts');
  });

  it('does not resolve a subpath whose wildcard suffix does not match', () => {
    const packageJson = JSON.stringify({ exports: { './lib/*-test': { types: './dist/*.d.ts', default: './dist/*.js' } } });
    // Long enough to pass the key-length check, so only the suffix can
    // refuse it: without the suffix check this would resolve to src/abcd.ts.
    assert.equal(subpathEntryFile(packageJson, 'packages/core', 'lib/abcdefgh'), undefined);
    assert.equal(subpathEntryFile(packageJson, 'packages/core', 'lib/foo-test'), 'packages/core/src/foo.ts');
  });

  it('follows a bare export star into a workspace sibling', () => {
    // The shape of the core move: e2e/agent re-exports the core package
    // through a bare specifier, and the names live in the core source.
    const files = new Map([
      [
        'packages/e2e/package.json',
        JSON.stringify({ exports: { './agent': { types: './dist/agent/public.d.ts', default: './dist/agent/public.js' } } }),
      ],
      ['packages/e2e/src/agent/public.ts', `export * from '@e2e-dev/core/lib/agent/public';\n`],
      [
        'packages/core/package.json',
        JSON.stringify({ exports: { './engine': { types: './dist/engine/index.d.ts', default: './dist/engine/index.js' }, './lib/*': { types: './dist/*.d.ts', default: './dist/*.js' } } }),
      ],
      [
        'packages/core/src/agent/public.ts',
        `export * from './tool.ts';\n`,
      ],
      ['packages/core/src/agent/tool.ts', `export function defineTool(): void {}\nexport interface DefinedTool {}\nexport interface ToolAnnotations {}\n`],
    ]);
    const read = (path: string): string | undefined => files.get(path);
    const dirs = new Map([
      ['e2e', 'packages/e2e'],
      ['@e2e-dev/core', 'packages/core'],
    ]);
    const resolveBare = (specifier: string): string | undefined => resolveWorkspaceSpecifier(read, dirs, specifier);
    const exported = resolveEntryExports(read, 'packages/e2e/src/agent/public.ts', resolveBare);
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['defineTool']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), ['DefinedTool', 'ToolAnnotations']);
  });

  it('does not follow a bare export star without a resolver', () => {
    const files = new Map([['packages/e2e/src/agent/public.ts', `export * from '@e2e-dev/core/lib/agent/public';\n`]]);
    const exported = resolveEntryExports((path) => files.get(path), 'packages/e2e/src/agent/public.ts');
    assert.deepEqual([...(exported?.values ?? [])], []);
    assert.deepEqual([...(exported?.types ?? [])], []);
  });

  it('follows a relative export star through the relative file, never the bare resolver', () => {
    const files = new Map([
      ['src/engine/index.ts', `export * from './local.ts';\n`],
      ['src/engine/local.ts', `export function fromRelative(): void {}\n`],
      ['packages/other/src/x.ts', `export function fromBare(): void {}\n`],
    ]);
    const seen: string[] = [];
    const resolveBare = (specifier: string): string | undefined => {
      seen.push(specifier);
      return specifier === './local.ts' ? 'packages/other/src/x.ts' : undefined;
    };
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts', resolveBare);
    assert.deepEqual([...(exported?.values ?? [])], ['fromRelative']);
    assert.deepEqual(seen, []);
  });

  it('does not fall through to the bare resolver when a relative export star has no file', () => {
    const files = new Map([
      ['src/engine/index.ts', `export * from './gone.ts';\n`],
      ['packages/other/src/x.ts', `export function fromBare(): void {}\n`],
    ]);
    const resolveBare = (specifier: string): string | undefined => (specifier === './gone.ts' ? 'packages/other/src/x.ts' : undefined);
    assert.equal(resolveEntryExports((path) => files.get(path), 'src/engine/index.ts', resolveBare), undefined);
  });
});

describe('resolveWorkspaceSpecifier', () => {
  const dirs = new Map([
    ['e2e', 'packages/e2e'],
    ['@e2e-dev/core', 'packages/core'],
  ]);
  const files = new Map([
    [
      'packages/core/package.json',
      JSON.stringify({
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './engine': { types: './dist/engine/index.d.ts', default: './dist/engine/index.js' },
          './lib/*': { types: './dist/*.d.ts', default: './dist/*.js' },
        },
      }),
    ],
    [
      'packages/e2e/package.json',
      JSON.stringify({ exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } }),
    ],
  ]);
  const read = (path: string): string | undefined => files.get(path);

  it('resolves an exact subpath and the bare entry', () => {
    assert.equal(resolveWorkspaceSpecifier(read, dirs, '@e2e-dev/core/engine'), 'packages/core/src/engine/index.ts');
    assert.equal(resolveWorkspaceSpecifier(read, dirs, '@e2e-dev/core'), 'packages/core/src/index.ts');
  });

  it('resolves a wildcard subpath', () => {
    assert.equal(resolveWorkspaceSpecifier(read, dirs, '@e2e-dev/core/lib/agent/public'), 'packages/core/src/agent/public.ts');
  });

  it('answers undefined for a package outside the workspace', () => {
    assert.equal(resolveWorkspaceSpecifier(read, dirs, 'zod'), undefined);
    assert.equal(resolveWorkspaceSpecifier(read, dirs, '@other/core/engine'), undefined);
  });

  it('does not match a package name without a slash boundary', () => {
    assert.equal(resolveWorkspaceSpecifier(read, dirs, '@e2e-dev/core2/engine'), undefined);
    assert.equal(resolveWorkspaceSpecifier(read, dirs, '@e2e-dev/corex'), undefined);
    // Without the boundary, @e2e-dev/core2 would read as the core package
    // with the rest cut off, resolving its bare entry.
    assert.equal(resolveWorkspaceSpecifier(read, dirs, '@e2e-dev/core2'), undefined);
  });

  it('prefers the longest package-name prefix', () => {
    const nestedFiles = new Map([
      ...files,
      [
        'packages/nested/package.json',
        JSON.stringify({ exports: { './engine': { types: './dist/engine/index.d.ts', default: './dist/engine/index.js' } } }),
      ],
    ]);
    const nestedDirs = new Map([
      ...dirs,
      ['@e2e-dev/core/nested', 'packages/nested'],
    ]);
    const nestedRead = (path: string): string | undefined => nestedFiles.get(path);
    assert.equal(
      resolveWorkspaceSpecifier(nestedRead, nestedDirs, '@e2e-dev/core/nested/engine'),
      'packages/nested/src/engine/index.ts',
    );
  });

  it('maps a wildcard subpath even when the file does not exist yet; the reader reports it missing', () => {
    assert.equal(resolveWorkspaceSpecifier(read, dirs, '@e2e-dev/core/lib/missing'), 'packages/core/src/missing.ts');
    const entryFiles = new Map([
      ['packages/e2e/src/agent/public.ts', `export * from '@e2e-dev/core/lib/missing';\n`],
      [
        'packages/core/package.json',
        JSON.stringify({ exports: { './lib/*': { types: './dist/*.d.ts', default: './dist/*.js' } } }),
      ],
    ]);
    const readEntry = (path: string): string | undefined => entryFiles.get(path);
    assert.equal(
      resolveEntryExports(readEntry, 'packages/e2e/src/agent/public.ts', (specifier) => resolveWorkspaceSpecifier(readEntry, dirs, specifier)),
      undefined,
    );
  });

  it('answers undefined when the manifest cannot be read', () => {
    assert.equal(resolveWorkspaceSpecifier(() => undefined, dirs, '@e2e-dev/core/engine'), undefined);
  });
});

describe('tagExportsAt', () => {
  // A tag record for a floor that exports the bare entry and ./engine,
  // but no ./agent: a package importing from e2e/agent against this
  // floor is a real gap, not an unverifiable floor.
  const tagFiles = new Map([
    [
      'packages/e2e/package.json',
      JSON.stringify({
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './engine': { types: './dist/engine/index.d.ts', default: './dist/engine/index.js' },
          './setup': { types: './dist/setup/index.d.ts', default: './dist/setup/index.js' },
        },
      }),
    ],
    ['packages/e2e/src/index.ts', `export function test(): void {}\n`],
    ['packages/e2e/src/engine/index.ts', `export function stepTimeout(): void {}\n`],
    ['packages/e2e/src/setup/index.ts', `import './register.ts';\nexport {};\n`],
    ['packages/e2e/src/setup/register.ts', `export function register(): void {}\n`],
  ]);
  const readAtTag = (path: string): string | undefined => tagFiles.get(path);
  const agentCheck: EngineImportCheck = {
    packageName: '@e2e-dev/acp',
    packagePath: 'packages/acp/package.json',
    sibling: 'e2e',
    floor: '0.22.0',
    imports: new Map([['agent', new Map<string, ImportKind>([['acp', 'value']])]]),
  };

  it('returns missing for a subpath the tag does not export', () => {
    assert.equal(tagExportsAt(readAtTag, 'packages/e2e', 'agent'), 'missing');
  });

  it('returns missing for a manifest with no exports map', () => {
    // A manifest without `exports` has no key covering any subpath, so
    // the subpath reads as missing, not unverifiable: resolve.exports
    // returns no targets for it.
    const files = new Map([['packages/e2e/package.json', JSON.stringify({ name: 'e2e' })]]);
    assert.equal(
      tagExportsAt((path) => files.get(path), 'packages/e2e', 'agent'),
      'missing',
    );
  });

  it('returns empty sets, not missing, for an entry that exports nothing', () => {
    const atSetup = tagExportsAt(readAtTag, 'packages/e2e', 'setup');
    if (atSetup === undefined || atSetup === 'missing') assert.fail('expected export sets for an entry that exists but exports nothing');
    assert.deepEqual([...atSetup.values], []);
    assert.deepEqual([...atSetup.types], []);
  });

  it('passes a side-effect import of an entry that exports nothing', () => {
    const sideEffect: EngineImportCheck = {
      packageName: '@e2e-dev/web',
      packagePath: 'packages/web/package.json',
      sibling: 'e2e',
      floor: '0.22.0',
      imports: new Map([['setup', new Map<string, ImportKind>()]]),
    };
    const { problems, unverifiable, verified } = engineImportProblems(
      [sideEffect],
      (_sibling, subpath) => tagExportsAt(readAtTag, 'packages/e2e', subpath),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(unverifiable, []);
    assert.equal(verified, 1);
  });

  it('fails a named import from a subpath the floor tag does not export', () => {
    const { problems, unverifiable, verified } = engineImportProblems(
      [agentCheck],
      (_sibling, subpath) => tagExportsAt(readAtTag, 'packages/e2e', subpath),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports from e2e\/agent, but e2e@0\.22\.0 does not export that subpath/);
    assert.deepEqual(unverifiable, []);
    assert.equal(verified, 1);
  });

  it('returns undefined when there is no tag record', () => {
    assert.equal(tagExportsAt(() => undefined, 'packages/e2e', 'engine'), undefined);
  });

  it('still reports a floor with no tag record as unverifiable, not a problem', () => {
    const { problems, unverifiable, verified } = engineImportProblems([agentCheck], () => undefined);
    assert.deepEqual(problems, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /cannot be verified, no tag record/);
    assert.equal(verified, 0);
  });

  it('returns undefined when the manifest does not parse', () => {
    assert.equal(tagExportsAt(() => 'not json', 'packages/e2e', 'agent'), undefined);
  });

  it('returns undefined for an export entry with no types target', () => {
    const files = new Map([
      ['packages/e2e/package.json', JSON.stringify({ exports: { './agent': { default: './dist/agent/public.js' } } })],
    ]);
    assert.equal(
      tagExportsAt((path) => files.get(path), 'packages/e2e', 'agent'),
      undefined,
    );
  });

  it('returns undefined, not missing, for a subpath a wildcard key covers without a types target', () => {
    // The entry exists, only its types target is missing, so the floor is
    // unverifiable, not a gap: the resolution must look past exact keys.
    const files = new Map([
      ['packages/e2e/package.json', JSON.stringify({ exports: { './lib/*': { default: './dist/*.js' } } })],
    ]);
    assert.equal(
      tagExportsAt((path) => files.get(path), 'packages/e2e', 'lib/agent'),
      undefined,
    );
  });

  it('reads the bare entry off a condition-sugar exports map', () => {
    // No wrapping of the condition-object form: resolve.exports reads
    // it as the `.` entry, so the bare entry resolves the same way.
    const files = new Map([
      ['packages/e2e/package.json', JSON.stringify({ exports: { types: './dist/index.d.ts', default: './dist/index.js' } })],
      ['packages/e2e/src/index.ts', `export function test(): void {}\n`],
    ]);
    const atBare = tagExportsAt((path) => files.get(path), 'packages/e2e', '');
    if (atBare === undefined || atBare === 'missing') assert.fail('expected export sets for a condition-sugar bare entry');
    assert.deepEqual([...atBare.values], ['test']);
  });

  it('returns missing for a require-only or browser-only export entry', () => {
    // An ESM import cannot use either, so for this check the sibling
    // does not export the subpath: missing, not unverifiable.
    const requireOnly = new Map([
      ['packages/e2e/package.json', JSON.stringify({ exports: { './engine': { require: './dist/engine.cjs' } } })],
    ]);
    assert.equal(
      tagExportsAt((path) => requireOnly.get(path), 'packages/e2e', 'engine'),
      'missing',
    );
    const browserOnly = new Map([
      ['packages/e2e/package.json', JSON.stringify({ exports: { './engine': { browser: './dist/engine.browser.js' } } })],
    ]);
    assert.equal(
      tagExportsAt((path) => browserOnly.get(path), 'packages/e2e', 'engine'),
      'missing',
    );
  });

  it('returns missing for a subpath a null target excludes', () => {
    const files = new Map([
      [
        'packages/e2e/package.json',
        JSON.stringify({ exports: { './lib/*': { types: './dist/*.d.ts', default: './dist/*.js' }, './null/*': null } }),
      ],
    ]);
    assert.equal(
      tagExportsAt((path) => files.get(path), 'packages/e2e', 'null/anything'),
      'missing',
    );
  });

  it('lets a null target on the longest match exclude the subpath even when a shorter key matches', () => {
    const files = new Map([
      [
        'packages/e2e/package.json',
        JSON.stringify({ exports: { './*': { types: './dist/*.d.ts', default: './dist/*.js' }, './null/*': null } }),
      ],
    ]);
    assert.equal(
      tagExportsAt((path) => files.get(path), 'packages/e2e', 'null/anything'),
      'missing',
    );
  });

  it('returns missing for a subpath whose types target is null', () => {
    const files = new Map([
      [
        'packages/e2e/package.json',
        JSON.stringify({ exports: { './engine': { types: null, default: './dist/engine.js' } } }),
      ],
    ]);
    assert.equal(
      tagExportsAt((path) => files.get(path), 'packages/e2e', 'engine'),
      'missing',
    );
  });

  it('returns missing for a subpath whose nested conditional types target is null', () => {
    const files = new Map([
      [
        'packages/e2e/package.json',
        JSON.stringify({
          exports: { './engine': { node: { types: null, default: './dist/engine.js' }, default: './dist/engine.js' } },
        }),
      ],
    ]);
    assert.equal(
      tagExportsAt((path) => files.get(path), 'packages/e2e', 'engine'),
      'missing',
    );
  });

  it('returns undefined, not missing, when the null is under a condition the check does not select', () => {
    // The browser branch is never selected under the node/types
    // conditions, so its null excludes nothing: the default target is
    // real, only its types are missing, and the floor stays unverifiable.
    const files = new Map([
      [
        'packages/e2e/package.json',
        JSON.stringify({ exports: { './engine': { browser: { types: null }, default: './dist/engine.js' } } }),
      ],
    ]);
    assert.equal(
      tagExportsAt((path) => files.get(path), 'packages/e2e', 'engine'),
      undefined,
    );
  });

  it('fails a named import from a subpath a nested conditional null excludes', () => {
    const files = new Map([
      [
        'packages/e2e/package.json',
        JSON.stringify({
          exports: { './engine': { node: { types: null, default: './dist/engine.js' }, default: './dist/engine.js' } },
        }),
      ],
    ]);
    const read = (path: string): string | undefined => files.get(path);
    const check: EngineImportCheck = {
      packageName: '@e2e-dev/web',
      packagePath: 'packages/web/package.json',
      sibling: 'e2e',
      floor: '0.22.0',
      imports: new Map([['engine', new Map<string, ImportKind>([['stepTimeout', 'value']])]]),
    };
    const { problems, unverifiable, verified } = engineImportProblems(
      [check],
      (_sibling, subpath) => tagExportsAt(read, 'packages/e2e', subpath),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports from e2e\/engine, but e2e@0\.22\.0 does not export that subpath/);
    assert.deepEqual(unverifiable, []);
    assert.equal(verified, 1);
  });

  it('returns missing for a subpath the wildcard key is too short for', () => {
    const files = new Map([
      ['packages/e2e/package.json', JSON.stringify({ exports: { './lib/*': { types: './dist/*.d.ts', default: './dist/*.js' } } })],
    ]);
    assert.equal(
      tagExportsAt((path) => files.get(path), 'packages/e2e', 'lib/'),
      'missing',
    );
  });

  it('follows a bare export star into a workspace sibling through the same read', () => {
    const files = new Map([
      [
        'packages/e2e/package.json',
        JSON.stringify({ exports: { './agent': { types: './dist/agent/public.d.ts', default: './dist/agent/public.js' } } }),
      ],
      ['packages/e2e/src/agent/public.ts', `export * from '@e2e-dev/core/lib/agent/public';\n`],
      [
        'packages/core/package.json',
        JSON.stringify({ exports: { './lib/*': { types: './dist/*.d.ts', default: './dist/*.js' } } }),
      ],
      [
        'packages/core/src/agent/public.ts',
        `export * from './tool.ts';\n`,
      ],
      ['packages/core/src/agent/tool.ts', `export function defineTool(): void {}\nexport interface DefinedTool {}\n`],
    ]);
    const read = (path: string): string | undefined => files.get(path);
    const dirs = new Map([
      ['e2e', 'packages/e2e'],
      ['@e2e-dev/core', 'packages/core'],
    ]);
    // The core manifest is read through the same `read` as the tag
    // lookup, so the bare target cannot resolve against another version.
    const atAgent = tagExportsAt(read, 'packages/e2e', 'agent', dirs);
    if (atAgent === undefined || atAgent === 'missing') assert.fail('expected export sets through the bare re-export');
    assert.deepEqual([...atAgent.values], ['defineTool']);
    assert.deepEqual([...atAgent.types], ['DefinedTool']);
  });

  it('reads no names through a bare export star without package dirs', () => {
    const files = new Map([
      [
        'packages/e2e/package.json',
        JSON.stringify({ exports: { './agent': { types: './dist/agent/public.d.ts', default: './dist/agent/public.js' } } }),
      ],
      ['packages/e2e/src/agent/public.ts', `export * from '@e2e-dev/core/lib/agent/public';\n`],
    ]);
    const atAgent = tagExportsAt((path) => files.get(path), 'packages/e2e', 'agent');
    if (atAgent === undefined || atAgent === 'missing') assert.fail('expected empty export sets, not missing');
    assert.deepEqual([...atAgent.values], []);
    assert.deepEqual([...atAgent.types], []);
  });
});

describe('engineImportProblems', () => {
  const check = (floor: string, imports: EngineImportMap): EngineImportCheck => ({
    packageName: '@e2e-dev/web',
    packagePath: 'packages/web/package.json',
    sibling: 'e2e',
    floor,
    imports,
  });
  const exported = (values: readonly string[], types: readonly string[] = []) => ({ values: new Set(values), types: new Set(types) });
  const named = (entries: readonly (readonly [string, ImportKind])[]): EngineImportMap =>
    new Map([['engine', new Map(entries)]]);

  it('fails an import the floor version does not export', () => {
    const { problems } = engineImportProblems(
      [check('0.22.0', named([['stepTimeout', 'value'], ['EngineError', 'value']]))],
      () => exported(['EngineError']),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `stepTimeout` from e2e\/engine, but e2e@0\.22\.0 does not export it/);
  });

  it('passes when the floor version exports every import', () => {
    const { problems, unverifiable } = engineImportProblems(
      [check('0.23.0', named([['stepTimeout', 'value']]))],
      () => exported(['stepTimeout', 'EngineError']),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(unverifiable, []);
  });

  it('passes a type import satisfied by a type-only export', () => {
    const { problems } = engineImportProblems(
      [check('0.23.0', named([['KeyModifier', 'type']]))],
      () => exported(['parseKey'], ['KeyModifier']),
    );
    assert.deepEqual(problems, []);
  });

  it('fails a value import satisfied only by a type-only export', () => {
    const { problems } = engineImportProblems(
      [check('0.23.0', named([['isKeyModifier', 'value'], ['parseKey', 'value'], ['KeyModifier', 'type']]))],
      () => exported(['parseKey'], ['KeyModifier', 'isKeyModifier']),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `isKeyModifier` from e2e\/engine/);
    assert.match(problems[0]!, /does not export it/);
  });

  it('reports a floor with no tag record as unverifiable, not a problem', () => {
    const { problems, unverifiable } = engineImportProblems([check('0.15.0', named([['EngineError', 'value']]))], () => undefined);
    assert.deepEqual(problems, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /cannot be verified, no tag record/);
  });

  it('reports a namespace import as unverifiable', () => {
    const { problems, unverifiable } = engineImportProblems(
      [check('0.23.0', new Map([['engine', new Map<string, ImportKind>([['*', 'value']])]]))],
      () => exported(['stepTimeout']),
    );
    assert.deepEqual(problems, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /imported as a namespace/);
  });

  it('fails a namespace import from a subpath the floor tag does not export', () => {
    const { problems, unverifiable } = engineImportProblems(
      [check('0.23.0', new Map([['nope', new Map<string, ImportKind>([['*', 'value']])]]))],
      () => 'missing',
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports from e2e\/nope, but e2e@0\.23\.0 does not export that subpath/);
    assert.deepEqual(unverifiable, []);
  });

  it('fails a side-effect import from a subpath the floor tag does not export', () => {
    const { problems, unverifiable } = engineImportProblems(
      [check('0.23.0', new Map([['nope2', new Map<string, ImportKind>()]]))],
      () => 'missing',
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports from e2e\/nope2, but e2e@0\.23\.0 does not export that subpath/);
    assert.deepEqual(unverifiable, []);
  });

  it('reports a namespace import from an entry that exports nothing as unverifiable, not a problem', () => {
    const { problems, unverifiable } = engineImportProblems(
      [check('0.23.0', new Map([['engine', new Map<string, ImportKind>([['*', 'value']])]]))],
      () => exported([]),
    );
    assert.deepEqual(problems, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /imported as a namespace/);
  });

  it('fails a named import from an entry that exports nothing', () => {
    const { problems } = engineImportProblems(
      [check('0.23.0', named([['stepTimeout', 'value']]))],
      () => exported([]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `stepTimeout` from e2e\/engine, but e2e@0\.23\.0 does not export it/);
  });

  it('fails an export-star-as re-export from a subpath the floor tag does not export', () => {
    const imports = engineImports(`export * as ns from 'e2e/missing';\n`);
    const { problems } = engineImportProblems(
      [{ packageName: '@e2e-dev/web', packagePath: 'packages/web/package.json', sibling: 'e2e', floor: '0.23.0', imports }],
      () => 'missing',
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports from e2e\/missing, but e2e@0\.23\.0 does not export that subpath/);
  });

  it('fails a core import the core floor does not export', () => {
    const coreCheck: EngineImportCheck = {
      packageName: '@e2e-dev/web',
      packagePath: 'packages/web/package.json',
      sibling: '@e2e-dev/core',
      floor: '0.24.0',
      imports: named([
        ['EngineError', 'value'],
        ['newContractField', 'value'],
      ]),
    };
    const { problems } = engineImportProblems([coreCheck], () => exported(['EngineError']));
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `newContractField` from @e2e-dev\/core\/engine, but @e2e-dev\/core@0\.24\.0 does not export it/);
  });

  it('passes a side-effect import from a subpath the floor tag exports', () => {
    const { problems, unverifiable, verified } = engineImportProblems(
      [check('0.23.0', new Map([['engine', new Map<string, ImportKind>()]]))],
      () => exported(['stepTimeout']),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(unverifiable, []);
    assert.equal(verified, 1);
  });

  it('fails a default import when the floor exports other names but no default', () => {
    const { problems } = engineImportProblems(
      [check('0.23.0', named([['default', 'value']]))],
      () => exported(['stepTimeout']),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `default` from e2e\/engine, but e2e@0\.23\.0 does not export it/);
  });

  it('passes a default import when the floor exports a default', () => {
    const { problems, unverifiable, verified } = engineImportProblems(
      [check('0.23.0', named([['default', 'value']]))],
      () => exported(['default', 'stepTimeout']),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(unverifiable, []);
    assert.equal(verified, 1);
  });

  it('does not count a check as verified when one of its subpaths has no tag record', () => {
    const twoSubpaths: EngineImportCheck = {
      packageName: '@e2e-dev/web',
      packagePath: 'packages/web/package.json',
      sibling: 'e2e',
      floor: '0.23.0',
      imports: new Map([
        ['engine', new Map<string, ImportKind>([['stepTimeout', 'value']])],
        ['agent', new Map<string, ImportKind>([['acp', 'value']])],
      ]),
    };
    const { problems, unverifiable, verified } = engineImportProblems(
      [twoSubpaths],
      (_sibling, subpath) => (subpath === 'engine' ? exported(['stepTimeout']) : undefined),
    );
    assert.deepEqual(problems, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /cannot be verified, no tag record/);
    assert.equal(verified, 0);
  });

  it('still validates named imports beside a namespace import', () => {
    const { problems, unverifiable } = engineImportProblems(
      [check('0.23.0', new Map([['engine', new Map<string, ImportKind>([['*', 'value'], ['stepTimeout', 'value']])]]))],
      () => exported(['EngineError']),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `stepTimeout` from e2e\/engine/);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /imported as a namespace/);
  });

  it('counts only the checks verified against a tag record', () => {
    const { problems, verified } = engineImportProblems(
      [
        check('0.23.0', named([['stepTimeout', 'value']])),
        check('0.15.0', named([['EngineError', 'value']])),
      ],
      (_sibling, _subpath, version) => (version === '0.23.0' ? exported(['stepTimeout']) : undefined),
    );
    assert.deepEqual(problems, []);
    assert.equal(verified, 1);
  });

  it('does not count a namespace-only check as verified', () => {
    const { verified } = engineImportProblems(
      [check('0.23.0', new Map([['engine', new Map<string, ImportKind>([['*', 'value']])]]))],
      () => exported(['stepTimeout']),
    );
    assert.equal(verified, 0);
  });
});

describe('floor export checks with in-memory fixtures', () => {
  const exported = (values: readonly string[], types: readonly string[] = []) => ({ values: new Set(values), types: new Set(types) });

  it('verifies every import against fixture export sets for two floors', () => {
    const checks: EngineImportCheck[] = [
      {
        packageName: '@e2e-dev/web',
        packagePath: 'packages/web/package.json',
        sibling: 'e2e',
        floor: '0.23.0',
        imports: new Map([['engine', new Map<string, ImportKind>([['stepTimeout', 'value'], ['EngineDoctorCheck', 'type']])]]),
      },
      {
        packageName: '@e2e-dev/acp',
        packagePath: 'packages/acp/package.json',
        sibling: 'e2e',
        floor: '0.22.0',
        imports: new Map([['agent', new Map<string, ImportKind>([['acp', 'value']])]]),
      },
    ];
    const { problems, unverifiable, verified } = engineImportProblems(checks, (_sibling, subpath, version) =>
      subpath === 'engine' && version === '0.23.0' ? exported(['stepTimeout'], ['EngineDoctorCheck']) : exported(['acp']),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(unverifiable, []);
    assert.equal(verified, 2);
  });

  it('catches the original bug: web imports stepTimeout, which the earlier fixture entry does not export', () => {
    const earlier = new Map([
      ['src/engine/index.ts', `export { EngineError } from './errors.ts';\nexport type { NodeRef } from './contract.ts';\n`],
      ['src/engine/errors.ts', `export class EngineError extends Error {}\n`],
      ['src/engine/contract.ts', `export type NodeRef = string;\n`],
    ]);
    const later = new Map([
      [
        'src/engine/index.ts',
        `export { EngineError } from './errors.ts';\nexport { stepTimeout } from './timing.ts';\nexport type { NodeRef, EngineDoctorCheck } from './contract.ts';\n`,
      ],
      ['src/engine/errors.ts', `export class EngineError extends Error {}\n`],
      ['src/engine/timing.ts', `export function stepTimeout(): void {}\n`],
      ['src/engine/contract.ts', `export type NodeRef = string;\nexport type EngineDoctorCheck = { ok: boolean };\n`],
    ]);
    const atEarlier = resolveEntryExports((path) => earlier.get(path), 'src/engine/index.ts');
    const atLater = resolveEntryExports((path) => later.get(path), 'src/engine/index.ts');
    assert.equal(atEarlier?.values.has('stepTimeout'), false);
    assert.equal(atEarlier?.types.has('EngineDoctorCheck'), false);
    assert.equal(atLater?.values.has('stepTimeout'), true);
    assert.equal(atLater?.types.has('EngineDoctorCheck'), true);
    const imports: EngineImportMap = new Map([['engine', new Map<string, ImportKind>([['stepTimeout', 'value']])]]);
    const check = (floor: string): EngineImportCheck => ({ packageName: '@e2e-dev/web', packagePath: 'packages/web/package.json', sibling: 'e2e', floor, imports });
    const { problems: earlierProblems } = engineImportProblems([check('0.22.0')], () => atEarlier);
    assert.equal(earlierProblems.length, 1);
    assert.match(earlierProblems[0]!, /imports `stepTimeout` from e2e\/engine/);
    const { problems: laterProblems } = engineImportProblems([check('0.23.0')], () => atLater);
    assert.deepEqual(laterProblems, []);
  });

  it('fails a default import against an entry with no default export, and passes once one is added', () => {
    const withoutDefault = new Map([
      ['src/engine/index.ts', `export function stepTimeout(): void {}\n`],
    ]);
    const withDefault = new Map([
      ['src/engine/index.ts', `export default function makeEngine(): void {}\nexport function stepTimeout(): void {}\n`],
    ]);
    const atWithout = resolveEntryExports((path) => withoutDefault.get(path), 'src/engine/index.ts');
    const atWith = resolveEntryExports((path) => withDefault.get(path), 'src/engine/index.ts');
    assert.equal(atWithout?.values.has('default'), false);
    assert.equal(atWith?.values.has('default'), true);
    const imports: EngineImportMap = new Map([['engine', new Map<string, ImportKind>([['default', 'value']])]]);
    const check = (floor: string): EngineImportCheck => ({ packageName: '@e2e-dev/web', packagePath: 'packages/web/package.json', sibling: 'e2e', floor, imports });
    const { problems: withoutProblems } = engineImportProblems([check('0.22.0')], () => atWithout);
    assert.equal(withoutProblems.length, 1);
    assert.match(withoutProblems[0]!, /imports `default` from e2e\/engine/);
    const { problems: withProblems } = engineImportProblems([check('0.23.0')], () => atWith);
    assert.deepEqual(withProblems, []);
  });

  it('counts a type-star re-export as a type, not a value, in fixture entries', () => {
    const files = new Map([
      ['src/engine/index.ts', `export type * from './contract.ts';\nexport { parseKey } from './contract.ts';\n`],
      [
        'src/engine/contract.ts',
        `export function isKeyModifier(value: unknown): boolean { return false; }\nexport function parseKey(value: string): string { return value; }\nexport type KeyModifier = 'Shift';\n`,
      ],
    ]);
    const exportedAt = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.equal(exportedAt?.values.has('isKeyModifier'), false);
    // A function reached through `export type *` has no value to
    // re-export, but its name is usable as a type through `typeof`, so a
    // type-only import of it is satisfied.
    assert.equal(exportedAt?.types.has('isKeyModifier'), true);
    assert.equal(exportedAt?.values.has('parseKey'), true);
    assert.equal(exportedAt?.types.has('KeyModifier'), true);
  });
});

describe('fixtureExportsAt', () => {
  const fixture = {
    package: 'e2e',
    version: '0.15.0',
    exports: {
      engine: { values: ['ConfigurationError', 'rejectUnknownKeys'], types: ['NodeRef'] },
    },
  };

  it('reads the export sets of a subpath the fixture lists', () => {
    const exported = fixtureExportsAt(fixture, 'e2e', '0.15.0', 'engine');
    assert.notEqual(exported, 'missing');
    assert.notEqual(exported, undefined);
    if (exported === undefined || exported === 'missing') return;
    assert.deepEqual([...exported.values].toSorted(), ['ConfigurationError', 'rejectUnknownKeys']);
    assert.deepEqual([...exported.types], ['NodeRef']);
  });

  it('answers missing for a subpath the fixture does not list', () => {
    assert.equal(fixtureExportsAt(fixture, 'e2e', '0.15.0', 'agent'), 'missing');
  });

  it('answers undefined for a fixture of another version or package', () => {
    assert.equal(fixtureExportsAt(fixture, 'e2e', '0.15.1', 'engine'), undefined);
    assert.equal(fixtureExportsAt(fixture, '@e2e-dev/core', '0.15.0', 'engine'), undefined);
  });

  it('answers undefined for a malformed fixture', () => {
    assert.equal(fixtureExportsAt({ package: 'e2e' }, 'e2e', '0.15.0', 'engine'), undefined);
    assert.equal(
      fixtureExportsAt({ package: 'e2e', version: '0.15.0', exports: { engine: { values: 'nope', types: [] } } }, 'e2e', '0.15.0', 'engine'),
      undefined,
    );
  });

  it('lists every subpath the published package exports', () => {
    const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/e2e@0.15.0.json', import.meta.url)), 'utf8'));
    assert.ok(typeof raw === 'object' && raw !== null && 'exports' in raw && typeof raw.exports === 'object' && raw.exports !== null);
    assert.deepEqual(Object.keys(raw.exports as Record<string, unknown>).toSorted(), ['', 'agent', 'engine', 'oauth/chatgpt', 'oauth/copilot', 'oauth/grok']);
  });

  it('verifies the published e2e@0.15.0 floor: a known present export passes beside the missing one', () => {
    const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/e2e@0.15.0.json', import.meta.url)), 'utf8'));
    const imports: EngineImportMap = new Map([
      ['engine', new Map<string, ImportKind>([['ConfigurationError', 'value'], ['stepTimeout', 'value']])],
    ]);
    const check: EngineImportCheck = {
      packageName: '@e2e-dev/limrun',
      packagePath: 'packages/limrun/package.json',
      sibling: 'e2e',
      floor: '0.15.0',
      imports,
    };
    const { problems, unverifiable } = engineImportProblems(
      [check],
      (sibling, subpath, version) => fixtureExportsAt(raw, sibling, version, subpath),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `stepTimeout` from e2e\/engine, but e2e@0\.15\.0 does not export it/);
    assert.deepEqual(unverifiable, []);
  });
});
