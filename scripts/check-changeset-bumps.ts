/**
 * Fails when a pending changeset bumps a `0.x` package by `minor` without a
 * summary opening `**Breaking:**` or `**Release:**`, or by `major` without
 * `**Release:**` (`changeset-bumps.ts` says why), or when a changeset
 * raises a package's peer floor on a sibling past a runner minor the
 * previous range accepted without a `**Breaking:**` minor
 * (`floorRaiseProblems` in `changeset-bumps.ts` says how a raise is judged).
 * The previous floor is the one at the package's release tag; on a
 * generated release PR the current version has no tag yet, so the previous
 * released tag is used instead, and the version bump from that tag counts
 * as the announcement when it is a `0.x` minor or a major. A sibling major
 * counts too, but only while that major is still unreleased: on a release PR
 * the sibling's major moves every peer to `>=<major>.0.0 <major+1>`, and
 * each engine gets only a patch bump, so the sibling's major is the
 * announcement for those floors. Once the tag for the sibling's version
 * exists the major has shipped, and a later floor raise to it needs its
 * own `**Breaking:**` minor.
 *
 * Usage: `node scripts/check-changeset-bumps.ts`, part of `pnpm check`. Exits
 * 1 listing every offending changeset.
 */

import { hasReleaseTag, listTags, pendingChangesets, readChangelog, showAtTag } from './check-helpers.ts';
import { BREAKING, RELEASE, collectFloorRaiseInputs, disallowedBumps, floorRaiseProblems, type BumpType } from './changeset-bumps.ts';
import { REPO_ROOT, publicPackages } from './public-packages.ts';

const versions = new Map(publicPackages().flatMap(({ manifest }) => (manifest.version === undefined ? [] : [[manifest.name, manifest.version] as const])));
const pending = pendingChangesets();
const problems: string[] = [];
const flagged = new Set<string>();
for (const { file, changeset } of pending) {
  for (const { name, type } of disallowedBumps(changeset, versions)) {
    flagged.add(name);
    const needs = type === 'major' ? RELEASE : `${BREAKING} or ${RELEASE}`;
    problems.push(`.changeset/${file}: ${type} bump of ${name} ${versions.get(name)}; on 0.x a feature or fix is a patch, and a ${type} needs a summary opening with ${needs}`);
  }
}

const changesByPackage = new Map<string, { type: BumpType; summary: string }[]>();
for (const { changeset } of pending) {
  for (const { name, type } of changeset.releases) {
    if (type !== 'patch' && type !== 'minor' && type !== 'major') continue;
    const list = changesByPackage.get(name) ?? [];
    list.push({ type, summary: changeset.summary });
    changesByPackage.set(name, list);
  }
}

// With no `e2e@*` tags at all there is no released version to compare a
// floor against, so the rule below would quietly skip every package.
// Fail loudly instead: a tagless checkout must fetch the tags.
if (listTags('e2e@*').length === 0) {
  problems.push('no e2e@* tags exist; a peer floor cannot be compared against any released version, so the check fails instead of quietly skipping (fetch the tags: git fetch --tags)');
}

const { inputs, skipped } = collectFloorRaiseInputs(
  publicPackages(),
  changesByPackage,
  flagged,
  { listTags, showAtTag, hasReleaseTag, readChangelog },
  REPO_ROOT,
);
problems.push(...floorRaiseProblems(inputs));

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `changeset bumps: ${pending.length} pending, none an unannounced 0.x minor or major; ${inputs.length} peer floor ${inputs.length === 1 ? 'change' : 'changes'} checked against their releases, none raised past an accepted minor without a **Breaking:** minor${skipped > 0 ? ` (${skipped} skipped: no release tag or changelog)` : ''}\n`,
  );
}
