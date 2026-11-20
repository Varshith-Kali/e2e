/**
 * Fails when a public package's peer on another public package (an engine's
 * on `e2e`, an integration's on an engine) is anything but
 * `>=<major.minor.patch> <major+1>`, or names a version the sibling never
 * released (no `## <version>` in its CHANGELOG.md, and no pending changeset
 * releasing it), or imports an `e2e/*` or `@e2e-dev/core/*` export the floor
 * version does not have (rule (c): a new `e2e/engine` or
 * `@e2e-dev/core/engine` import counts as raising the floor).
 *
 * A floor naming the version the sibling's pending changesets will release,
 * or the version `changeset version` just wrote into the sibling's manifest
 * with no tag yet, has no tag to read, so its imports are verified against
 * the working tree, which is that release's source, instead of passing on
 * an unverifiable note. A published version with no tag at all (e2e@0.15.0)
 * is verified against the export fixture in `scripts/fixtures`, recorded
 * from its published tarball.
 *
 * `changeset version --snapshot canary` rewrites those peers to the siblings'
 * exact canary versions; `restore-peer-ranges.ts` puts the ranges back after
 * a publish, and this check is what notices when it did not run. See
 * `peer-ranges.ts` for why the floor must be a released version and
 * `engine-exports.ts` for how the floor version's exports are read.
 *
 * Usage: `node scripts/check-peer-ranges.ts`, part of `pnpm check`. Exits 1
 * listing every offending peer.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { collectEngineImports, hasReleaseTag, isJustVersionedFloor, listTags, loadExportFixture, nextReleaseVersions, pendingChangesets, readChangelog, showAtTag, workspacePackages } from './check-helpers.ts';
import { engineImportProblems, fixtureExportsAt, tagExportsAt, type EngineImportCheck, type TagExports } from './engine-exports.ts';
import { peerFloor, peerRangeProblems } from './peer-ranges.ts';
import { REPO_ROOT, publicPackages, siblingPeers } from './public-packages.ts';

const packages = publicPackages();
const siblings = new Set(packages.map(({ manifest }) => manifest.name));
const checked: string[] = [];
for (const { manifest } of packages) {
  for (const [peer, range] of siblingPeers(manifest.peerDependencies, siblings)) {
    checked.push(`${manifest.name} on ${peer} (${range})`);
  }
}

// The version each sibling's pending changesets will release: a floor may
// name it as the sibling's version in the same release. Computed by
// changesets itself, so a fixed group releases together at one version:
// `e2e` and `@e2e-dev/core` release together, and the core package's first
// release is the runner's next version, not a `0.0.1` patch of its own.
const pending = pendingChangesets();
const nextVersions = await nextReleaseVersions(await workspacePackages(), pending);

const problems = peerRangeProblems(packages, readChangelog, nextVersions);

// With no `e2e@*` tags at all there is no tag record to verify any import
// against, so rule (c) would quietly pass every package. Fail loudly
// instead: a tagless checkout must fetch the tags.
if (listTags('e2e@*').length === 0) {
  problems.push('no e2e@* tags exist; no e2e import can be verified against its floor version, so the check fails instead of quietly passing (fetch the tags: git fetch --tags)');
}

// With no `@e2e-dev/core@*` tags at all there is no tag record to verify any
// core import against, so rule (c) would quietly pass every package. Fail
// loudly instead: a tagless checkout must fetch the tags.
if (listTags('@e2e-dev/core@*').length === 0) {
  problems.push('no @e2e-dev/core@* tags exist; no core import can be verified against its floor version, so the check fails instead of quietly passing (fetch the tags: git fetch --tags)');
}

// Rule (c): every named import from a sibling (`e2e/*`,
// `@e2e-dev/core/*`) must be exported by that sibling at the package's peer
// floor, read off the `<sibling>@<floor>` tag.
const siblingDirs = new Map(packages.map(({ manifest, path }) => [manifest.name, relative(REPO_ROOT, dirname(path))]));
const siblingVersions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]));
const exportsCache = new Map<string, TagExports | undefined>();
const fixtureCache = new Map<string, unknown>();

/** Reads `path` from the working tree, undefined when it cannot be read. */
function showWorkingTree(path: string): string | undefined {
  try {
    return readFileSync(join(REPO_ROOT, path), 'utf8');
  } catch {
    return undefined;
  }
}

const exportsAt = (sibling: string, subpath: string, version: string): TagExports | undefined => {
  const key = `${sibling}@${version}:${subpath}`;
  if (exportsCache.has(key)) return exportsCache.get(key);
  const siblingDir = siblingDirs.get(sibling);
  const tagRead = (path: string): string | undefined => showAtTag(`${sibling}@${version}`, path);
  let resolved = siblingDir === undefined ? undefined : tagExportsAt(tagRead, siblingDir, subpath, siblingDirs);
  if (resolved === undefined && siblingDir !== undefined && (nextVersions.get(sibling) === version || isJustVersionedFloor(siblingVersions.get(sibling), version, hasReleaseTag(sibling, version)))) {
    // A floor naming the version the sibling's pending changesets will
    // release, or the version `changeset version` just wrote into the
    // sibling's manifest with no tag yet, has no tag to read; the working
    // tree is that release's source, so verify against it instead of
    // passing the floor on an unverifiable note.
    resolved = tagExportsAt(showWorkingTree, siblingDir, subpath, siblingDirs);
  }
  if (resolved === undefined) {
    // A published version with no tag cannot be read off git; the export
    // fixture recorded from its tarball verifies it instead.
    const fixtureKey = `${sibling}@${version}`;
    if (!fixtureCache.has(fixtureKey)) fixtureCache.set(fixtureKey, loadExportFixture(sibling, version));
    resolved = fixtureExportsAt(fixtureCache.get(fixtureKey), sibling, version, subpath);
  }
  exportsCache.set(key, resolved);
  return resolved;
};

/** The import checks for every package peering on `sibling`: its imports from that sibling, verified against its peer floor. */
function importChecks(sibling: string): EngineImportCheck[] {
  const checks: EngineImportCheck[] = [];
  for (const { path, manifest } of packages) {
    const range = manifest.peerDependencies?.[sibling];
    if (range === undefined) continue;
    const floor = peerFloor(range);
    if (floor === undefined) continue;
    const imports = collectEngineImports(path, sibling);
    if (imports.size === 0) continue;
    checks.push({ packageName: manifest.name, packagePath: relative(REPO_ROOT, path), sibling, floor, imports });
  }
  return checks;
}
const e2eResult = engineImportProblems(importChecks('e2e'), exportsAt);
const coreResult = engineImportProblems(importChecks('@e2e-dev/core'), exportsAt);
problems.push(...e2eResult.problems, ...coreResult.problems);
const unverifiable = [...e2eResult.unverifiable, ...coreResult.unverifiable];

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`peer ranges: ${checked.toSorted().join(', ')} as wide ranges on released versions; ${e2eResult.verified} packages' e2e imports and ${coreResult.verified} packages' core imports verified against their floors\n`);
}
for (const note of unverifiable) {
  process.stdout.write(`note: ${note}\n`);
}
