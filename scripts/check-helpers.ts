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
import { getPackages, type Packages } from '@manypkg/get-packages';
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

/** The tags matching `pattern` in `cwd` (`git tag --list`), empty when git cannot list them. */
export function listTags(pattern: string, cwd: string = REPO_ROOT): string[] {
  try {
    return execFileSync('git', ['tag', '--list', pattern], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  } catch {
    return [];
  }
}

/** Whether `name@version` has a release tag in `cwd`. */
export function hasReleaseTag(name: string, version: string, cwd: string = REPO_ROOT): boolean {
  return listTags(`${name}@${version}`, cwd).length > 0;
}

/**
 * Whether a floor naming `floor` should be verified against the working
 * tree even though no pending changeset releases it: the sibling's current
 * version is that floor (`changeset version` has consumed the entry) and
 * its release tag does not exist yet. Between versioning and publish the
 * working tree is the release's source, so it verifies the floor the tag
 * cannot yet.
 */
export function isJustVersionedFloor(siblingVersion: string | undefined, floor: string, hasTag: boolean): boolean {
  return siblingVersion !== undefined && siblingVersion === floor && !hasTag;
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

/** The named `e2e` or `@e2e-dev/core` imports in a package's `src/` tree, keyed by subpath. `packagePath` is the path to the package's `package.json`. `sibling` defaults to `e2e`; pass `@e2e-dev/core` for the engine contract. */
export function collectEngineImports(packagePath: string, sibling = 'e2e'): EngineImportMap {
  const imports = new Map<string, Map<string, ImportKind>>();
  for (const file of sourceFiles(join(dirname(packagePath), 'src'))) {
    try {
      addEngineImports(imports, engineImports(readFileSync(file, 'utf8'), sibling));
    } catch (error) {
      // A file that fails to parse names no file in the error from
      // engineImports, so say which one it was.
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return imports;
}

/** The export fixture for `sibling` at `version`, parsed off `scripts/fixtures/<sibling>@<version>.json` in the working tree; undefined when there is no such file, or it does not parse. The caller validates its shape. */
export function loadExportFixture(sibling: string, version: string): unknown {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'fixtures', `${sibling}@${version}.json`), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
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

/** Every package in the workspace, private and version-less ones included: the release plan needs the whole workspace, since a changeset may name any of them. Read with the same `getPackages` changesets itself uses, so the check sees exactly the workspace `changeset version` sees. A version-less package (like `@e2e-dev/docs`) is skipped by the plan, not released. */
export async function workspacePackages(): Promise<Packages> {
  return getPackages(REPO_ROOT);
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
  packages: Packages,
  changesets: readonly { file: string; changeset: Changeset }[],
): Promise<Map<string, string>> {
  // changesets prints a line to stderr per dependent whose peer does not
  // name the sibling's current version yet, from both `readConfig` and
  // `assembleReleasePlan`; on a passing run those lines read as failures
  // in the check log, so only that expected message stays inside this
  // call. Anything else still reaches stderr: a real failure throws, or
  // comes back in the `errors` array, and unexpected output stays visible.
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (args.map((arg) => String(arg)).join(' ').includes('must depend on the current version')) return;
    originalError(...args);
  };
  let plan: ReturnType<typeof assembleReleasePlan>;
  try {
    let read: Awaited<ReturnType<typeof readConfig>>;
    try {
      read = await readConfig(packages.rootDir, packages);
    } catch (error) {
      // A malformed config throws out of readConfig instead of returning
      // errors, so catch it here and report it as a config failure.
      throw new Error(`cannot read .changeset/config.json: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const { config, errors } = read;
    if (config === undefined || errors !== undefined) {
      throw new Error(`cannot read .changeset/config.json: ${(errors ?? ['unknown error']).join('; ')}`);
    }
    plan = assembleReleasePlan(
      changesets.map(({ file, changeset }) => ({
        id: file.replace(/\.md$/, ''),
        summary: changeset.summary,
        releases: changeset.releases,
      })),
      packages,
      config,
      undefined,
    );
  } finally {
    console.error = originalError;
  }
  const versions = new Map<string, string>();
  for (const release of plan.releases) {
    if (release.type !== 'none' && release.newVersion !== undefined) versions.set(release.name, release.newVersion);
  }
  return versions;
}
