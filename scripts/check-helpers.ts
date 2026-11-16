/**
 * Shared file and git reads for the release check scripts: the tag lookup,
 * the source walk and import collection, the changelog read, the pending
 * changesets, and the versions those changesets will release at. One place,
 * so the check scripts and their tests do not each reimplement them.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assembleReleasePlan } from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import { parseChangesetFile } from '@changesets/parse';
import { addEngineImports, engineImports, type EngineImportMap, type ImportKind } from './engine-exports.ts';
import { REPO_ROOT } from './public-packages.ts';
import type { Changeset } from './changeset-bumps.ts';

/** Reads `path` at `tag` (`git show`), undefined when the tag or the file does not exist. */
export function showAtTag(tag: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${tag}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

/** The tags matching `pattern` (`git tag --list`), empty when git cannot list them. */
export function listTags(pattern: string): string[] {
  try {
    return execFileSync('git', ['tag', '--list', pattern], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  } catch {
    return [];
  }
}

/** The TypeScript files under `dirPath`, recursively; unreadable entries are skipped. */
function sourceFiles(dirPath: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) out.push(full);
      } catch {
        continue;
      }
    }
  };
  walk(dirPath);
  return out;
}

/** The named `e2e` imports in a package's `src/` tree, keyed by subpath. `packagePath` is the path to the package's `package.json`. */
export function collectEngineImports(packagePath: string): EngineImportMap {
  const imports = new Map<string, Map<string, ImportKind>>();
  for (const file of sourceFiles(join(dirname(packagePath), 'src'))) {
    try {
      addEngineImports(imports, engineImports(readFileSync(file, 'utf8')));
    } catch (error) {
      // A file that fails to parse names no file in the error from
      // engineImports, so say which one it was.
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return imports;
}

/** The CHANGELOG.md beside `packagePath`, undefined when it cannot be read. */
export function readChangelog(packagePath: string): string | undefined {
  try {
    return readFileSync(join(dirname(packagePath), 'CHANGELOG.md'), 'utf8');
  } catch {
    return undefined;
  }
}

/** The pending changesets: every `.md` file in `.changeset` except the README, parsed, in file order. */
export function pendingChangesets(): { file: string; changeset: ReturnType<typeof parseChangesetFile> }[] {
  const dir = join(REPO_ROOT, '.changeset');
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .toSorted();
  return files.map((file) => ({ file, changeset: parseChangesetFile(readFileSync(join(dir, file), 'utf8')) }));
}

/** A workspace package for the changesets release plan: its directory and manifest, dependency ranges included, since the plan bumps dependents whose ranges go out of range. */
export interface ReleasePlanPackage {
  readonly dir: string;
  readonly packageJson: {
    readonly name: string;
    readonly version: string;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
    readonly peerDependencies?: Record<string, string>;
    readonly optionalDependencies?: Record<string, string>;
    readonly private?: boolean;
  };
}

/** Every named package under `packages/`, private ones included: the release plan needs the whole workspace, since a changeset may name any of them. */
export function workspacePackages(): ReleasePlanPackage[] {
  const packages: ReleasePlanPackage[] = [];
  for (const dir of readdirSync(join(REPO_ROOT, 'packages'))) {
    const path = join(REPO_ROOT, 'packages', dir, 'package.json');
    let manifest: Partial<ReleasePlanPackage['packageJson']>;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReleasePlanPackage['packageJson']>;
    } catch {
      continue;
    }
    if (manifest.name === undefined || manifest.version === undefined) continue;
    packages.push({ dir: join(REPO_ROOT, 'packages', dir), packageJson: manifest as ReleasePlanPackage['packageJson'] });
  }
  return packages;
}

/**
 * The version each package's pending changesets will release at, computed
 * by changesets itself (`assembleReleasePlan`): a `fixed` group releases
 * every member at the group's highest current version with the group's
 * highest bump, and a dependent whose range goes out of range gets a
 * patch. Only packages the plan releases are in the map. Throws when
 * `.changeset/config.json` cannot be read or is malformed: a broken
 * config must fail the check loudly, not read as no fixed groups.
 */
export async function nextReleaseVersions(
  packages: readonly ReleasePlanPackage[],
  changesets: readonly { file: string; changeset: Changeset }[],
  cwd: string = REPO_ROOT,
): Promise<Map<string, string>> {
  // The dependents graph is empty without a root package, so the plan
  // cannot see dependents at all; read the root manifest for it.
  let rootManifest: { name: string; version: string };
  try {
    rootManifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name: string; version: string };
  } catch {
    rootManifest = { name: '', version: '0.0.0' };
  }
  const planPackages = {
    rootDir: cwd,
    rootPackage: { dir: cwd, packageJson: rootManifest },
    packages: packages.map((pkg) => ({ dir: pkg.dir, packageJson: pkg.packageJson })),
    tool: { type: 'pnpm' },
  } as Parameters<typeof assembleReleasePlan>[1];
  let read: Awaited<ReturnType<typeof readConfig>>;
  try {
    read = await readConfig(cwd, planPackages);
  } catch (error) {
    // A malformed config throws out of readConfig instead of returning
    // errors, so catch it here and report it as a config failure.
    throw new Error(`cannot read .changeset/config.json: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const { config, errors } = read;
  if (config === undefined || errors !== undefined) {
    throw new Error(`cannot read .changeset/config.json: ${(errors ?? ['unknown error']).join('; ')}`);
  }
  const plan = assembleReleasePlan(
    changesets.map(({ file, changeset }) => ({
      id: file.replace(/\.md$/, ''),
      summary: changeset.summary,
      releases: changeset.releases,
    })),
    planPackages,
    config,
    undefined,
  );
  const versions = new Map<string, string>();
  for (const release of plan.releases) {
    if (release.type !== 'none' && release.newVersion !== undefined) versions.set(release.name, release.newVersion);
  }
  return versions;
}
