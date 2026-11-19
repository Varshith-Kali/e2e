/**
 * The bump policy for pending changesets while a package is `0.x`.
 *
 * Changesets applies whatever bump a changeset declares, and one `minor` in a
 * release moves the package from `0.20.x` to `0.21.0`. On `0.x` that is the
 * breaking slot: semver tools read `^0.20.0` as `>=0.20.0 <0.21.0`, so a
 * project `e2e init` set up never picks up a minor without editing its
 * `package.json`. A feature or fix is a `patch`. A `minor` is for a breaking
 * change or a release a maintainer calls, its summary opening with
 * `**Breaking:**` or `**Release:**`. A `major` makes it `1.0.0`, outside every
 * sibling's `>=x <1` peer range, so only a `**Release:**` may carry one.
 *
 * Rule (a): a changeset that raises a package's peer floor on a sibling
 * past a runner minor the previous range accepted must be a `**Breaking:**`
 * minor. The check script pairs each pending changeset with the floor
 * change it ships: the previous floor is the one at the package's release
 * tag, the current floor is the working tree's, and a raise counts only
 * when it cuts off a *released* version on an older minor. A correction
 * from a never-published floor to the released version it already meant
 * cuts off nothing a consumer could install, so a patch carries it. The
 * rule lives in this check, not in `check-peer-ranges.ts`, because only
 * this check reads the changesets that must announce the raise.
 */

import { relative } from 'node:path';
import { parseChangesetFile } from '@changesets/parse';
import { peerFloor, releasedVersions } from './peer-ranges.ts';
import { isWidePeerRange, siblingPeers, type PackageManifest } from './public-packages.ts';

export type Changeset = ReturnType<typeof parseChangesetFile>;

export const BREAKING = '**Breaking:**';
export const RELEASE = '**Release:**';

/** The `minor` and `major` bumps in `changeset` of a `0.x` package in `versions` that its summary does not allow. */
export function disallowedBumps(changeset: Changeset, versions: ReadonlyMap<string, string>): { name: string; type: 'minor' | 'major' }[] {
  const allowed = changeset.summary.startsWith(RELEASE) ? ['minor', 'major'] : changeset.summary.startsWith(BREAKING) ? ['minor'] : [];
  return changeset.releases.flatMap(({ name, type }) =>
    (type === 'minor' || type === 'major') && !allowed.includes(type) && versions.get(name)?.startsWith('0.') === true ? [{ name, type }] : [],
  );
}

export type BumpType = 'patch' | 'minor' | 'major';
export type Semver = readonly [major: number, minor: number, patch: number];

/** Parses a strict `x.y.z` version; undefined for anything else. */
export function parseVersion(version: string): Semver | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return [Number(major), Number(minor), Number(patch)];
}

/** The version comparison: -1, 0, or 1, semver order on `x.y.z` triples. Negative when `a` is older, 0 when equal, positive when newer. */
function compareVersions(a: Semver, b: Semver): number {
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

/**
 * Whether raising a peer floor from `previousFloor` to `currentFloor`
 * cuts off a released version on an older runner minor: some version in
 * `released` that the previous range accepted (`>=previousFloor` in its
 * major) sits below the new floor on an older minor. A raise within one
 * minor, a lowering, and a correction from a never-published floor to the
 * version it already meant in practice all answer false.
 */
export function floorRaisesPastMinor(previousFloor: string, currentFloor: string, released: ReadonlySet<string>): boolean {
  const previous = parseVersion(previousFloor);
  const current = parseVersion(currentFloor);
  if (previous === undefined || current === undefined) return false;
  if (compareVersions(current, previous) <= 0) return false;
  for (const version of released) {
    const candidate = parseVersion(version);
    if (candidate === undefined || candidate[0] !== previous[0]) continue;
    if (compareVersions(candidate, previous) < 0 || compareVersions(candidate, current) >= 0) continue;
    if (candidate[0] !== current[0] || candidate[1] < current[1]) return true;
  }
  return false;
}

/** Whether a changeset entry of `type` with `summary` announces a floor raise: a minor opening `**Breaking:**`, or a major opening `**Release:**`. A `**Release:**` minor does not announce one: a floor raise past an accepted runner minor must be a `**Breaking:**` minor, and a release train is not that signal. A major needs no breaking prefix because the major itself is the signal: no `0.x` consumer picks it up without opting in. */
export function announcesFloorRaise(type: BumpType, summary: string): boolean {
  if (type === 'minor') return summary.startsWith(BREAKING);
  if (type === 'major') return summary.startsWith(RELEASE);
  return false;
}

/** Whether the version change from `previousVersion` to `currentVersion` announces a floor raise on its own: a `0.x` minor, or a major. On a release PR the changesets are already consumed, so the bump the release carries is the announcement; a patch bump is not one. */
export function versionBumpAnnounces(previousVersion: string, currentVersion: string): boolean {
  const previous = parseVersion(previousVersion);
  const current = parseVersion(currentVersion);
  if (previous === undefined || current === undefined) return false;
  if (current[0] > previous[0]) return true;
  if (previous[0] === 0 && current[0] === 0 && current[1] > previous[1]) return true;
  return false;
}

/**
 * Whether a sibling major announces a peer floor raise to it: the sibling's
 * major moves every peer to `>=<major>.0.0 <major+1>` while each engine gets
 * only a patch bump, so the sibling's major is the announcement. Only while
 * that major is still unreleased (`siblingReleased` false): once its tag
 * exists the major has shipped, and a later floor raise to it is a breaking
 * change of its own that needs a `**Breaking:**` minor.
 */
export function siblingMajorAnnounces(previousFloor: string, currentFloor: string, siblingVersion: string, siblingReleased: boolean): boolean {
  const previous = parseVersion(previousFloor);
  const current = parseVersion(currentFloor);
  if (previous === undefined || current === undefined) return false;
  if (siblingReleased) return false;
  return siblingVersion === currentFloor && current[0] !== previous[0];
}

/** The latest released version of `name` among `tags` (`<name>@<x.y.z>`), undefined when none exists. The bump check falls back to it when the tag for a package's current version does not exist yet, which is exactly a generated release PR: `version-packages` has already bumped the version, so the current tag is missing and the previous released manifest is the one to compare the floor against. */
export function latestReleaseVersion(tags: readonly string[], name: string): string | undefined {
  let latest: Semver | undefined;
  for (const tag of tags) {
    if (!tag.startsWith(`${name}@`)) continue;
    const version = parseVersion(tag.slice(name.length + 1));
    if (version === undefined) continue;
    if (latest === undefined || compareVersions(version, latest) > 0) latest = version;
  }
  return latest === undefined ? undefined : latest.join('.');
}

const BUMP_RANK: Record<BumpType, number> = { patch: 0, minor: 1, major: 2 };

export interface FloorRaiseInput {
  readonly name: string;
  readonly path: string;
  readonly peer: string;
  readonly previousFloor: string;
  readonly currentFloor: string;
  readonly released: ReadonlySet<string>;
  readonly changes: readonly { type: BumpType; summary: string }[];
  readonly alreadyFlagged: boolean;
  /** The release carrying this floor change already bumped the package by a `0.x` minor or a major, or the sibling by a major that is still unreleased, so its consumed changesets announced the raise. */
  readonly announcedByVersionBump: boolean;
}

/** The repo reads the floor-raise collection needs: tag lookups and the sibling changelog. The check script passes the real reads; tests pass stubs, so a stubbed `hasReleaseTag` returning true must change the result, which pins the call site. */
export interface FloorRaiseReaders {
  listTags(pattern: string): string[];
  showAtTag(tag: string, path: string): string | undefined;
  hasReleaseTag(name: string, version: string): boolean;
  readChangelog(packagePath: string): string | undefined;
}

/**
 * Every peer floor change in `packages` as a `FloorRaiseInput` for
 * `floorRaiseProblems`, plus how many packages were skipped for want of a
 * release tag or changelog. The previous floor is the one at the package's
 * release tag, or at its previous released tag when the current version
 * has none yet, as on a generated release PR.
 */
export function collectFloorRaiseInputs(
  packages: readonly { path: string; manifest: PackageManifest }[],
  changesByPackage: ReadonlyMap<string, readonly { type: BumpType; summary: string }[]>,
  flagged: ReadonlySet<string>,
  readers: FloorRaiseReaders,
  rootDir: string,
): { inputs: FloorRaiseInput[]; skipped: number } {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const siblings = new Set(packages.map(({ manifest }) => manifest.name));
  const inputs: FloorRaiseInput[] = [];
  let skipped = 0;
  const previousReleaseManifest = (name: string, packagePath: string): string | undefined => {
    const latest = latestReleaseVersion(readers.listTags(`${name}@*`), name);
    if (latest === undefined) return undefined;
    return readers.showAtTag(`${name}@${latest}`, packagePath);
  };
  for (const { path, manifest } of packages) {
    if (manifest.version === undefined) continue;
    let tagManifest = readers.showAtTag(`${manifest.name}@${manifest.version}`, relative(rootDir, path));
    const fellBack = tagManifest === undefined;
    if (fellBack) tagManifest = previousReleaseManifest(manifest.name, relative(rootDir, path));
    if (tagManifest === undefined) {
      skipped += 1;
      continue;
    }
    let previous: Partial<PackageManifest>;
    try {
      previous = JSON.parse(tagManifest) as Partial<PackageManifest>;
    } catch {
      skipped += 1;
      continue;
    }
    for (const [peer, range] of siblingPeers(manifest.peerDependencies, siblings)) {
      if (!isWidePeerRange(range)) continue;
      const currentFloor = peerFloor(range);
      const previousRange = previous.peerDependencies?.[peer];
      const previousFloor = previousRange === undefined ? undefined : peerFloor(previousRange);
      if (currentFloor === undefined || previousFloor === undefined || currentFloor === previousFloor) continue;
      const sibling = byName.get(peer);
      if (sibling === undefined) continue;
      const changelog = readers.readChangelog(sibling.path);
      if (changelog === undefined) {
        skipped += 1;
        continue;
      }
      inputs.push({
        name: manifest.name,
        path: relative(rootDir, path),
        peer,
        previousFloor,
        currentFloor,
        released: releasedVersions(changelog),
        changes: changesByPackage.get(manifest.name) ?? [],
        alreadyFlagged: flagged.has(manifest.name),
        announcedByVersionBump:
          (fellBack && previous.version !== undefined && versionBumpAnnounces(previous.version, manifest.version)) ||
          // A sibling major moves every peer to `>=<major>.0.0 <major+1>` (restore-peer-ranges.ts); the sibling's major is the announcement, but only while it is still unreleased: a tag for the sibling's version means the major has shipped, and a later floor raise to it needs its own **Breaking:** minor.
          siblingMajorAnnounces(
            previousFloor,
            currentFloor,
            sibling.manifest.version ?? '',
            sibling.manifest.version !== undefined && readers.hasReleaseTag(peer, sibling.manifest.version),
          ),
      });
    }
  }
  return { inputs, skipped };
}

/**
 * Every floor raise in `inputs` that no pending changeset announces as a
 * `**Breaking:**` minor. A package whose bump `disallowedBumps` already
 * flags is skipped: the same summary fix (opening it with `**Breaking:**`)
 * cures both, so it is reported once, there. A raise the release's own
 * version bump announces is skipped too: on a release PR the changesets
 * are already consumed, so there is no pending changeset left to carry
 * the announcement.
 */
export function floorRaiseProblems(inputs: readonly FloorRaiseInput[]): string[] {
  const problems: string[] = [];
  for (const input of inputs) {
    if (!floorRaisesPastMinor(input.previousFloor, input.currentFloor, input.released)) continue;
    if (input.announcedByVersionBump) continue;
    if (input.changes.some((change) => announcesFloorRaise(change.type, change.summary))) continue;
    if (input.alreadyFlagged) continue;
    const highest = input.changes.reduce<BumpType | undefined>(
      (top, change) => (top === undefined || BUMP_RANK[change.type] > BUMP_RANK[top] ? change.type : top),
      undefined,
    );
    // A `**Release:**` minor is already a minor: only its summary prefix
    // is wrong, so the hint names the prefix, not the bump.
    const releaseMinor = input.changes.some((change) => change.type === 'minor' && change.summary.startsWith(RELEASE));
    const fix =
      highest === undefined
        ? `with no changeset for ${input.name}; add a minor changeset whose summary opens ${BREAKING}`
        : releaseMinor
          ? `with only a minor changeset whose summary opens ${RELEASE}; change the summary to open ${BREAKING} instead`
          : `with only a ${highest} bump; make it a minor whose summary opens ${BREAKING}`;
    problems.push(
      `${input.path}: ${input.peer} peer floor rises ${input.previousFloor} -> ${input.currentFloor}, past a runner minor the previous range accepted, ${fix}`,
    );
  }
  return problems;
}
