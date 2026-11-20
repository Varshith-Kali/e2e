/**
 * Rule (c): an engine that starts importing a new `e2e/engine` export
 * counts as raising the floor. This module verifies it: every import a
 * package takes from a sibling (`e2e`, or `@e2e-dev/core` for the engine
 * contract) or one of its subpaths must be exported by that sibling at
 * the version the package's peer floor names, including namespace and
 * side-effect imports, which record the subpath even though they name no
 * exports, and default imports, which record the `default` binding.
 *
 * Imports and exports come from oxc-parser's module info, not pattern
 * matching, so comments and JSDoc examples never count. Declaration
 * kinds come from the parsed declaration: interfaces and type aliases
 * are types only, classes and enums are both, the rest are values.
 *
 * The export set at a version comes from the `<sibling>@<version>` tag (the
 * entry file off the sibling's `package.json` `exports`, `export *`
 * chains followed). A floor with no tag is unverifiable, not a failure,
 * unless the check script can verify it against an export fixture
 * recorded from the published tarball; see `fixtureExportsAt`.
 * A value import needs a value export; a type import is satisfied by
 * either kind, and still needs the name at the floor, since the
 * package's published `.d.ts` names it.
 */

import { parseSync } from 'oxc-parser';
import { exports as resolveExports } from 'resolve.exports';

/** Whether an import takes the name as a value or only as a type. A value import needs a value export; a type import is satisfied by either kind. */
export type ImportKind = 'value' | 'type';

/** The named imports from `e2e` and its subpaths in one source file, keyed by subpath (`''` is the bare `e2e` entry), each name with its kind. A value import of a name subsumes a type import of the same name. */
export type EngineImportMap = ReadonlyMap<string, ReadonlyMap<string, ImportKind>>;

/** The subpath of a `sibling` specifier (`''` for the bare entry), undefined for any other package. */
function siblingSubpath(specifier: string, sibling: string): string | undefined {
  if (specifier === sibling) return '';
  if (specifier.startsWith(`${sibling}/`)) return specifier.slice(sibling.length + 1);
  return undefined;
}

type AstNode = Record<string, unknown>;

function isRecord(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null;
}

/** Parses `source` as a TypeScript module, throwing when oxc-parser reports errors instead of reading a half-parsed file silently. */
function parseModule(source: string): ReturnType<typeof parseSync> {
  const parsed = parseSync('file.ts', source, { lang: 'ts', sourceType: 'module' });
  if (parsed.errors.length > 0) {
    throw new Error(`failed to parse TypeScript source: ${parsed.errors[0]?.message ?? 'unknown parse error'}`);
  }
  return parsed;
}

/** The `exports` key for a subpath (`'.'` for the bare entry). */
function exportKey(subpath: string): string {
  return subpath === '' ? '.' : `./${subpath}`;
}

/** Records `names` into `target`, a value import of a name winning over a type import of the same name. */
function mergeImportKinds(target: Map<string, ImportKind>, names: Iterable<readonly [string, ImportKind]>): void {
  for (const [name, kind] of names) {
    const existing = target.get(name);
    if (existing === undefined || kind === 'value') target.set(name, kind);
  }
}

/** Merges `names` into `target`'s map for `subpath`, creating it when absent. */
function mergeInto(target: Map<string, Map<string, ImportKind>>, subpath: string, names: Iterable<readonly [string, ImportKind]>): void {
  let map = target.get(subpath);
  if (map === undefined) {
    map = new Map<string, ImportKind>();
    target.set(subpath, map);
  }
  mergeImportKinds(map, names);
}

/** The `import(...)` call in `node`, unwrapping `await` and parentheses; undefined when `node` is not one. */
function importCall(node: unknown): AstNode | undefined {
  let current: unknown = node;
  while (isRecord(current) && (current.type === 'AwaitExpression' || current.type === 'ParenthesizedExpression')) {
    current = current.type === 'AwaitExpression' ? current.argument : current.expression;
  }
  if (!isRecord(current) || current.type !== 'ImportExpression') return undefined;
  return current;
}

/** The source of an `import(...)` call; undefined when `node` is not one. */
function importCallSource(node: unknown): string | undefined {
  const call = importCall(node);
  if (call === undefined) return undefined;
  const source = call.source;
  if (!isRecord(source) || source.type !== 'Literal' || typeof source.value !== 'string') return undefined;
  return source.value;
}

/** The first name of a `TSImportType` qualifier (`A` of `import('x').A.B`), undefined when there is none. */
function firstQualifierName(qualifier: unknown): string | undefined {
  if (!isRecord(qualifier)) return undefined;
  if (qualifier.type === 'Identifier' && typeof qualifier.name === 'string') return qualifier.name;
  if (qualifier.type === 'TSQualifiedName') return firstQualifierName(qualifier.left);
  return undefined;
}

/** The module exports a destructuring pattern reads: the top-level keys of an object pattern, or undefined when the pattern cannot be enumerated (a rest element, a whole-module binding, or anything but an object pattern). A nested pattern reads a property of an export, not another export, so only top-level keys count. */
function patternNames(pattern: unknown): string[] | undefined {
  if (!isRecord(pattern)) return undefined;
  if (pattern.type !== 'ObjectPattern' || !Array.isArray(pattern.properties)) return undefined;
  const names: string[] = [];
  for (const property of pattern.properties) {
    if (!isRecord(property)) return undefined;
    if (property.type !== 'Property') return undefined;
    const key = property.key;
    if (!isRecord(key) || key.type !== 'Identifier' || typeof key.name !== 'string') return undefined;
    names.push(key.name);
  }
  return names;
}

/** Walks every node in `value`, calling `visit` on each object node. */
function walkAst(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkAst(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  for (const child of Object.values(value)) walkAst(child, visit);
}

/** The named imports from the sibling and its subpaths in one source file, keyed by subpath (`''` is the bare entry). A namespace import is recorded as the name `'*'`, which the check cannot enumerate; a side-effect import records the subpath with no names, so the check still verifies the subpath exists at the floor; a default import records the name `default`, so a floor without one fails the check. `sibling` defaults to `e2e`; pass `@e2e-dev/core` for the engine contract. */
export function engineImports(source: string, sibling = 'e2e'): EngineImportMap {
  const found = new Map<string, Map<string, ImportKind>>();
  const add = (subpath: string, names: readonly (readonly [string, ImportKind])[]): void => {
    mergeInto(found, subpath, names);
  };
  const parsed = parseModule(source);
  for (const statement of parsed.module.staticImports) {
    const subpath = siblingSubpath(statement.moduleRequest.value, sibling);
    if (subpath === undefined) continue;
    // Record the subpath even when the import names nothing: a
    // side-effect import (`import 'e2e/engine'`) has no entries, but it
    // still needs the subpath to exist at the floor.
    add(subpath, []);
    for (const entry of statement.entries) {
      if (entry.importName.kind === 'NamespaceObject') add(subpath, [['*', 'value']]);
      else if (entry.importName.kind === 'Default') add(subpath, [['default', entry.isType ? 'type' : 'value']]);
      else if (entry.importName.kind === 'Name' && entry.importName.name !== null) {
        add(subpath, [[entry.importName.name, entry.isType ? 'type' : 'value']]);
      }
    }
  }
  // A re-export from a sibling entry is an import too: the package depends
  // on the export existing at its floor. `export * from` cannot be
  // enumerated, so it is recorded as a namespace import.
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      const moduleRequest = entry.moduleRequest?.value;
      if (moduleRequest === undefined) continue;
      const subpath = siblingSubpath(moduleRequest, sibling);
      if (subpath === undefined) continue;
      add(subpath, []);
      if (entry.importName.kind === 'AllButDefault') add(subpath, [['*', 'value']]);
      else if (entry.importName.kind === 'Name' && entry.importName.name !== null) {
        add(subpath, [[entry.importName.name, entry.isType ? 'type' : 'value']]);
      }
      // `export * as ns` exports one name and imports no names, but the
      // subpath above is still recorded, since the module must exist.
    }
  }
  // A dynamic import takes its names the same way, when they are
  // destructured; any other use cannot be enumerated, so it is recorded as
  // the namespace name, like a namespace import. One walk handles both:
  // a declarator is visited before its `import(...)` child, so the child
  // is skipped once the declarator has recorded it.
  const handled = new Set<object>();
  walkAst(parsed.program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const sourceSpecifier = importCallSource(node.init);
      if (sourceSpecifier === undefined) return;
      const subpath = siblingSubpath(sourceSpecifier, sibling);
      if (subpath === undefined) return;
      const call = importCall(node.init);
      if (call !== undefined) handled.add(call);
      const names = patternNames(node.id);
      add(
        subpath,
        names === undefined ? [['*', 'value']] : names.map((name): readonly [string, ImportKind] => [name, 'value']),
      );
      return;
    }
    // An inline import type (`import('e2e/engine').Name`, `typeof
    // import('e2e').test`) is a type import of the qualifier's first
    // name, with no name when there is no qualifier; the subpath is
    // recorded either way, since the module must exist at the floor.
    if (node.type === 'TSImportType') {
      const sourceNode = node.source;
      if (!isRecord(sourceNode) || sourceNode.type !== 'Literal' || typeof sourceNode.value !== 'string') return;
      const subpath = siblingSubpath(sourceNode.value, sibling);
      if (subpath === undefined) return;
      add(subpath, []);
      const first = firstQualifierName(node.qualifier);
      if (first !== undefined) add(subpath, [[first, 'type']]);
      return;
    }
    if (node.type !== 'ImportExpression' || handled.has(node)) return;
    const sourceSpecifier = importCallSource(node);
    if (sourceSpecifier === undefined) return;
    const subpath = siblingSubpath(sourceSpecifier, sibling);
    if (subpath === undefined) return;
    add(subpath, [['*', 'value']]);
  });
  return found;
}

/** Merges `source` into `target`, a value import of a name winning over a type import of the same name. */
export function addEngineImports(target: Map<string, Map<string, ImportKind>>, source: EngineImportMap): void {
  for (const [subpath, names] of source) {
    mergeInto(target, subpath, names);
  }
}

/** The kind of each name a top-level `export` declaration introduces. Two declarations of one name (interface plus namespace) merge to both. */
function declarationKinds(program: ReturnType<typeof parseSync>['program']): Map<string, 'type' | 'value' | 'both'> {
  const kinds = new Map<string, 'type' | 'value' | 'both'>();
  const set = (name: string, kind: 'type' | 'value' | 'both'): void => {
    const existing = kinds.get(name);
    if (existing === undefined) kinds.set(name, kind);
    else if (existing !== kind) kinds.set(name, 'both');
  };
  const collectBindings = (pattern: unknown): void => {
    if (!isRecord(pattern)) return;
    if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
      set(pattern.name, 'value');
      return;
    }
    if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
      for (const property of pattern.properties) {
        if (!isRecord(property)) continue;
        if (property.type === 'RestElement') collectBindings(property.argument);
        else if (property.type === 'Property') collectBindings(property.value);
      }
      return;
    }
    if (pattern.type === 'ArrayPattern' && Array.isArray(pattern.elements)) {
      for (const element of pattern.elements) collectBindings(element);
      return;
    }
    if (pattern.type === 'AssignmentPattern') collectBindings(pattern.left);
    else if (pattern.type === 'RestElement') collectBindings(pattern.argument);
  };
  for (const statement of program.body) {
    const node: unknown = statement;
    if (!isRecord(node) || node.type !== 'ExportNamedDeclaration') continue;
    const declaration = node.declaration;
    if (!isRecord(declaration)) continue;
    const id = declaration.id;
    const name = isRecord(id) && typeof id.name === 'string' ? id.name : undefined;
    if (declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSTypeAliasDeclaration') {
      if (name !== undefined) set(name, 'type');
    } else if (declaration.type === 'ClassDeclaration' || declaration.type === 'TSEnumDeclaration') {
      if (name !== undefined) set(name, 'both');
    } else if (declaration.type === 'FunctionDeclaration' || declaration.type === 'TSDeclareFunction' || declaration.type === 'TSModuleDeclaration') {
      if (name !== undefined) set(name, 'value');
    } else if (declaration.type === 'VariableDeclaration' && Array.isArray(declaration.declarations)) {
      for (const declarator of declaration.declarations) {
        if (isRecord(declarator)) collectBindings(declarator.id);
      }
    }
  }
  return kinds;
}

/** The names one file exports, split by kind, and the modules its `export *` pulls in (relative ones, and bare ones when a resolver follows them). A `type` export or declaration lands in `types`; a class or enum lands in both, since its name is usable as a type; anything else value-like lands in `values`. `export type *` targets are kept apart from value `export *` targets: the former re-export types only. */
function exportedNames(source: string): {
  values: ReadonlySet<string>;
  types: ReadonlySet<string>;
  starModules: readonly string[];
  typeStarModules: readonly string[];
} {
  const parsed = parseModule(source);
  const values = new Set<string>();
  const types = new Set<string>();
  const starModules: string[] = [];
  const typeStarModules: string[] = [];
  const declared = declarationKinds(parsed.program);
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      const moduleRequest = entry.moduleRequest?.value;
      if (moduleRequest !== undefined) {
        // `export * as ns` exports only the namespace name, not the
        // module's names, so it is recorded as one export and its star
        // chain is not followed.
        if (entry.importName.kind === 'AllButDefault') {
          (entry.isType ? typeStarModules : starModules).push(moduleRequest);
        } else if (entry.importName.kind === 'All' || entry.importName.kind === 'Name') {
          const name = entry.exportName.name;
          if (name !== null) (entry.isType ? types : values).add(name);
        }
        continue;
      }
      const name = entry.exportName.name;
      if (entry.exportName.kind === 'Default') {
        // `export default ...` exports the name `default`: a default
        // import of this entry is satisfied only by one.
        (entry.isType ? types : values).add('default');
        continue;
      }
      if (entry.exportName.kind !== 'Name' || name === null) continue;
      const kind = declared.get(name);
      if (kind === 'type') types.add(name);
      else if (kind === 'both') {
        values.add(name);
        types.add(name);
      } else if (kind === 'value') values.add(name);
      else if (entry.isType) types.add(name);
      else values.add(name);
    }
  }
  return { values, types, starModules, typeStarModules };
}

/** The names an entry exports, split by kind. */
export interface ExportSets {
  readonly values: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
}

/** The export state of a subpath at a version: its export sets when the tag exports the subpath, `'missing'` when the tag record exists but the sibling does not export that subpath there. */
export type TagExports = ExportSets | 'missing';

/** Resolves a relative module specifier against the file that imports it; undefined for a bare specifier. */
export function resolveModule(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/**
 * Resolves a bare module specifier to a repo source file, or undefined
 * when it names no workspace package. The check passes one built from the
 * workspace manifests; tests pass a fake.
 */
export type BareSpecifierResolver = (specifier: string) => string | undefined;

/**
 * The export set of the entry file, split by kind, following `export *`
 * chains. A file reached through `export type *` contributes its types,
 * and its values as types: a function or const there has no value to
 * re-export, but its name is usable as a type through `typeof`. A file
 * reached through `export *` contributes no `default`: ESM `export *`
 * never re-exports `default`, so only the entry file's own default
 * counts. `readFile` reads a repo path (undefined when it has none); the caller
 * binds it to a version, for example `git show <tag>:<path>`.
 * A bare `export *` specifier is followed through `resolveBare` when one
 * is given: a re-export from another workspace package (for example
 * `e2e/agent` re-exporting `@e2e-dev/core/lib/agent/public`) contributes
 * that package's names. Without one, bare chains are not followed, so a
 * name that only arrives that way reads as missing.
 */
export function resolveEntryExports(
  readFile: (path: string) => string | undefined,
  entryPath: string,
  resolveBare?: BareSpecifierResolver,
): ExportSets | undefined {
  const values = new Set<string>();
  const types = new Set<string>();
  const seen = new Set<string>();
  // [file, typeOnly, viaStar]: `viaStar` is true when the file is
  // reached through an `export *`, which never passes `default` through.
  const queue: [string, boolean, boolean][] = [[entryPath, false, false]];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) continue;
    const [file, typeOnly, viaStar] = next;
    const key = `${file}:${typeOnly ? 'type' : 'value'}:${viaStar ? 'star' : 'entry'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = readFile(file);
    if (source === undefined) return undefined;
    const exported = exportedNames(source);
    // A file reached through `export type *` contributes its values as
    // types only: a function or const there has no value to re-export,
    // but its name is usable as a type through `typeof`. A value star
    // reached that way is followed as type-only too. `export *` never
    // passes `default` through, so a star-reached file contributes none.
    for (const name of exported.types) {
      if (viaStar && name === 'default') continue;
      types.add(name);
    }
    for (const name of exported.values) {
      if (viaStar && name === 'default') continue;
      if (typeOnly) types.add(name);
      else values.add(name);
    }
    const enqueue = (specifier: string, asType: boolean): void => {
      const target = specifier.startsWith('.') ? resolveModule(file, specifier) : resolveBare?.(specifier);
      if (target !== undefined) queue.push([target, asType, true]);
    };
    for (const specifier of exported.starModules) enqueue(specifier, typeOnly);
    for (const specifier of exported.typeStarModules) enqueue(specifier, true);
  }
  return { values, types };
}

/**
 * The source file for a sibling's subpath entry, from the sibling's
 * `package.json` (`exports` `types` target, resolved by resolve.exports
 * and mapped from `dist/` to `src/`). `subpath` is `''` for the bare
 * entry. Undefined when the package has no such export, or its manifest
 * does not parse.
 */
export function subpathEntryFile(packageJson: string, siblingDir: string, subpath: string): string | undefined {
  const manifest = parseManifest(packageJson);
  if (manifest === undefined) return undefined;
  return entryFileFromExports(manifest, siblingDir, subpath);
}

/** A parsed package manifest, as much of it as resolve.exports reads. */
type PackageManifest = {
  readonly name: string;
  readonly exports?: unknown;
};

/**
 * Parses a package manifest, keeping only what resolve.exports reads.
 * Undefined when the JSON does not parse.
 */
function parseManifest(packageJson: string): PackageManifest | undefined {
  let parsed: { name?: unknown; exports?: unknown };
  try {
    parsed = JSON.parse(packageJson) as { name?: unknown; exports?: unknown };
  } catch {
    return undefined;
  }
  return { name: typeof parsed.name === 'string' ? parsed.name : '', exports: parsed.exports };
}

/**
 * The export state of one subpath under the check's `types` resolution.
 * `missing` when no key covers the subpath, or the selected target is
 * null: resolve.exports throws for both, so either throw means missing.
 * `covered` when a key resolves to a real target; `typesTarget` is the
 * `.d.ts` target when the entry has one, and undefined when it does not.
 * resolve.exports always matches `default` too, so a covering entry with
 * no `types` target resolves to its JavaScript file instead, and a
 * `types` target listed after `default` loses to it by key order; both
 * stay unverifiable rather than missing, since the entry exists. A
 * condition-object `exports` needs no wrapping: resolve.exports reads
 * it as the `.` entry. A `require`- or `browser`-only entry reads as
 * missing, not unverifiable: an ESM import cannot use it, so for this
 * check the sibling does not export the subpath.
 */
type ExportResolution =
  | { readonly state: 'missing' }
  | { readonly state: 'covered'; readonly typesTarget: string | undefined };

/**
 * Resolves one subpath in a package manifest, once, under the `types`
 * condition: the missing-or-covered answer and the types target together.
 */
function resolveExport(manifest: PackageManifest, subpath: string): ExportResolution {
  let targets: readonly string[] | undefined;
  try {
    targets = resolveExports(manifest, exportKey(subpath), { conditions: ['types'] }) ?? undefined;
  } catch {
    return { state: 'missing' };
  }
  if (targets === undefined || targets.length === 0) return { state: 'missing' };
  return { state: 'covered', typesTarget: targets.find((target) => target.endsWith('.d.ts')) };
}

/** The source file for a `.d.ts` types target, mapped from `dist/` to `src/`. */
function entryFileForTypesTarget(typesTarget: string, siblingDir: string): string {
  return `${siblingDir}/src/${typesTarget.replace(/^\.\/dist\//, '').replace(/\.d\.ts$/, '.ts')}`;
}

/** The entry file for a subpath from an already-parsed package manifest. */
function entryFileFromExports(manifest: PackageManifest, siblingDir: string, subpath: string): string | undefined {
  const resolved = resolveExport(manifest, subpath);
  if (resolved.state !== 'covered' || resolved.typesTarget === undefined) return undefined;
  return entryFileForTypesTarget(resolved.typesTarget, siblingDir);
}

/**
 * The source file a bare specifier resolves to, through the workspace
 * package it names: the longest package-name prefix wins, and the rest
 * is the subpath in that package's `exports` map (`*` keys included),
 * mapped from `dist/` to `src/` the same way. `readFile` reads a repo
 * path at the version being verified, so a tag read resolves against
 * the tag's manifests. Undefined when the specifier names no package
 * in `packageDirs`, or that package has no such export.
 */
export function resolveWorkspaceSpecifier(
  readFile: (path: string) => string | undefined,
  packageDirs: ReadonlyMap<string, string>,
  specifier: string,
): string | undefined {
  let matchedName: string | undefined;
  let matchedDir: string | undefined;
  for (const [name, dir] of packageDirs) {
    if ((specifier === name || specifier.startsWith(`${name}/`)) && (matchedName === undefined || name.length > matchedName.length)) {
      matchedName = name;
      matchedDir = dir;
    }
  }
  if (matchedName === undefined || matchedDir === undefined) return undefined;
  const manifest = readFile(`${matchedDir}/package.json`);
  if (manifest === undefined) return undefined;
  const rest = specifier.slice(matchedName.length);
  const subpath = rest === '' ? '' : rest.slice(1);
  return subpathEntryFile(manifest, matchedDir, subpath);
}

/**
 * The export state of a sibling's subpath at a version. `readFile` reads a
 * repo path at that version. `packageDirs` maps workspace package names to
 * their directories: a bare `export *` into another workspace package is
 * resolved through that package's manifest read by the same `readFile`,
 * so the bare target is read at the same version as the tag lookup and
 * the two reads cannot diverge. Undefined when the tag record cannot be
 * read (no manifest, unparseable manifest, unreadable entry). `'missing'`
 * when the record exists but the sibling does not export that subpath
 * there: every import from it is then a problem, not unverifiable. Empty
 * sets when the entry exists but exports nothing: a side-effect import of
 * it passes, a named import still fails on the name. An export entry with
 * no types target stays unverifiable, since no entry file can be found
 * for it that way.
 */
export function tagExportsAt(
  readFile: (path: string) => string | undefined,
  siblingDir: string,
  subpath: string,
  packageDirs?: ReadonlyMap<string, string>,
): TagExports | undefined {
  const manifest = readFile(`${siblingDir}/package.json`);
  if (manifest === undefined) return undefined;
  const pkg = parseManifest(manifest);
  if (pkg === undefined) return undefined;
  const resolveBare: BareSpecifierResolver | undefined =
    packageDirs === undefined ? undefined : (specifier: string): string | undefined => resolveWorkspaceSpecifier(readFile, packageDirs, specifier);
  const resolved = resolveExport(pkg, subpath);
  if (resolved.state === 'missing') return 'missing';
  if (resolved.typesTarget === undefined) return undefined;
  return resolveEntryExports(readFile, entryFileForTypesTarget(resolved.typesTarget, siblingDir), resolveBare);
}

/** Whether `value` is an array of strings. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * The export state of one subpath in an export fixture: the export sets of
 * every subpath the published package exports, recorded from its tarball
 * (`scripts/fixtures/<sibling>@<version>.json`). Its `exports` map is
 * closed: a subpath it does not list is one the published package does not
 * export. Returns the subpath's export sets when the fixture lists it,
 * `'missing'` when the fixture is for this sibling and version but lists
 * no such subpath. Undefined when the fixture is not an export fixture
 * for this sibling and version, or the entry is malformed: a fixture that
 * cannot be trusted stays unverifiable rather than failing the check on
 * bad data.
 */
export function fixtureExportsAt(fixture: unknown, sibling: string, version: string, subpath: string): TagExports | undefined {
  if (!isRecord(fixture)) return undefined;
  if (fixture.package !== sibling || fixture.version !== version) return undefined;
  const exports = fixture.exports;
  if (!isRecord(exports)) return undefined;
  const entry = exports[subpath];
  if (entry === undefined) return 'missing';
  if (!isRecord(entry) || !isStringArray(entry.values) || !isStringArray(entry.types)) return undefined;
  return { values: new Set(entry.values), types: new Set(entry.types) };
}

export interface EngineImportCheck {
  readonly packageName: string;
  readonly packagePath: string;
  readonly sibling: string;
  readonly floor: string;
  readonly imports: EngineImportMap;
}

/**
 * Every import in `checks` the sibling does not export at the floor
 * version, plus the floors that could not be verified. A namespace
 * import is unverifiable, since its names cannot be enumerated, unless
 * the floor tag does not export the subpath at all, which is a problem.
 * A side-effect import is verified when the tag exports the subpath; a
 * default import is checked against the `default` export like any other
 * name. `verified` counts the checks whose imports were all
 * checked against a tag record.
 */
export function engineImportProblems(
  checks: readonly EngineImportCheck[],
  exportsAt: (sibling: string, subpath: string, version: string) => TagExports | undefined,
): { problems: string[]; unverifiable: string[]; verified: number } {
  const problems: string[] = [];
  const unverifiable: string[] = [];
  let verified = 0;
  for (const check of checks) {
    let checked = false;
    let allResolved = true;
    for (const [subpath, names] of check.imports) {
      const label = subpath === '' ? check.sibling : `${check.sibling}/${subpath}`;
      const exported = exportsAt(check.sibling, subpath, check.floor);
      if (exported === undefined) {
        unverifiable.push(`${check.packagePath}: ${label} at ${check.sibling}@${check.floor} cannot be verified, no tag record for that version; the floor must still name a released version`);
        allResolved = false;
        continue;
      }
      if (exported === 'missing') {
        problems.push(
          `${check.packagePath}: imports from ${label}, but ${check.sibling}@${check.floor} does not export that subpath; a new ${label} import counts as raising the floor, so raise the ${check.sibling} peer floor to the first version that exports it (as a **Breaking:** minor when it passes a runner minor the previous range accepted)`,
        );
        checked = true;
        continue;
      }
      const named = [...names].filter(([name]) => name !== '*');
      if (names.has('*')) {
        unverifiable.push(`${check.packagePath}: ${label} is imported as a namespace, so its names cannot be verified against ${check.sibling}@${check.floor}`);
      }
      // A namespace-only import names nothing to check, so it does not
      // count the check as verified; any other import was checked
      // against the tag record, including a side-effect import, whose
      // only question is whether the subpath exists.
      if (named.length > 0 || !names.has('*')) checked = true;
      const missing = named
        .filter(([name, kind]) => (kind === 'value' ? !exported.values.has(name) : !exported.values.has(name) && !exported.types.has(name)))
        .map(([name]) => name)
        .toSorted();
      if (missing.length > 0) {
        problems.push(
          `${check.packagePath}: imports ${missing.map((name) => `\`${name}\``).join(', ')} from ${label}, but ${check.sibling}@${check.floor} does not export ${missing.length === 1 ? 'it' : 'them'}; a new ${label} import counts as raising the floor, so raise the ${check.sibling} peer floor to the first version that exports ${missing.length === 1 ? 'it' : 'them'} (as a **Breaking:** minor when it passes a runner minor the previous range accepted)`,
        );
      }
    }
    if (checked && allResolved) verified += 1;
  }
  return { problems, unverifiable, verified };
}
