import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseChangesetFile } from '@changesets/parse';
import { collectEngineImports, hasReleaseTag, nextReleaseVersions, workspacePackages, type ReleasePlanPackage } from './check-helpers.ts';
import { REPO_ROOT } from './public-packages.ts';

describe('collectEngineImports', () => {
  it('names the file that fails to parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-check-helpers-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg' }));
      writeFileSync(join(dir, 'src', 'broken.ts'), 'export const = ;\n');
      assert.throws(
        () => collectEngineImports(join(dir, 'package.json')),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /broken\.ts/);
          assert.match(error.message, /failed to parse/);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hasReleaseTag', () => {
  it('finds a released tag and misses an unreleased version', () => {
    // e2e@0.23.0 is tagged; 99.99.99 never shipped, and docs has no
    // release tags at all. Replacing the lookup with `false` must fail
    // the first assertion: the sibling-major announcement in
    // check-changeset-bumps.ts hangs on this call.
    assert.equal(hasReleaseTag('e2e', '0.23.0'), true);
    assert.equal(hasReleaseTag('e2e', '99.99.99'), false);
    assert.equal(hasReleaseTag('@e2e-dev/docs', '0.0.0'), false);
  });
});

describe('workspacePackages', () => {
  it('reads the workspace packages with their versions', async () => {
    const packages = await workspacePackages();
    const byName = new Map(packages.map((pkg) => [pkg.packageJson.name, pkg.packageJson.version]));
    // Compare against each package's own manifest, not pinned versions:
    // the next Version Packages run bumps both, and a pinned version
    // here would fail there. The check still bites: a helper that drops
    // a package, or reads a wrong version for one, fails against its
    // own manifest.
    for (const dir of ['e2e', 'core']) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      };
      assert.equal(byName.get(manifest.name), manifest.version);
    }
  });

  it('reads the private apps too: a changeset may name any of them', async () => {
    const packages = await workspacePackages();
    const byName = new Map(packages.map((pkg) => [pkg.packageJson.name, pkg.packageJson.version]));
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'testbed', 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    assert.equal(byName.get(manifest.name), manifest.version);
  });

  it('reads the version-less docs package too: a changeset may name it', async () => {
    const packages = await workspacePackages();
    const docs = packages.find((pkg) => pkg.packageJson.name === '@e2e-dev/docs');
    assert.ok(docs !== undefined);
    assert.equal(docs.packageJson.version, undefined);
    assert.equal(docs.dir, join(REPO_ROOT, 'docs'));
  });
});

describe('nextReleaseVersions', () => {
  // The fixed group in the repo config: e2e and @e2e-dev/core release at
  // one version, the group's highest current version with its highest bump.
  const e2e: ReleasePlanPackage = {
    dir: 'packages/e2e',
    packageJson: { name: 'e2e', version: '0.23.1', dependencies: { '@e2e-dev/core': 'workspace:*' } },
  };
  const core: ReleasePlanPackage = { dir: 'packages/core', packageJson: { name: '@e2e-dev/core', version: '0.0.0' } };
  const web: ReleasePlanPackage = {
    dir: 'packages/web',
    packageJson: { name: '@e2e-dev/web', version: '0.16.0', peerDependencies: { e2e: '>=0.23.2 <1', '@e2e-dev/core': '>=0.23.2 <1' } },
  };
  const changeset = (file: string, frontmatter: string) => ({
    file,
    changeset: parseChangesetFile(`---\n${frontmatter}\n---\n\nA change.\n`),
  });

  it('versions a fixed group the way changesets does: highest current version plus highest bump', async () => {
    // The repro from review: a core minor on top of the pending e2e patch
    // releases both at 0.24.0, not at the 0.23.2 the hand-rolled math gave.
    const versions = await nextReleaseVersions(
      [e2e, core],
      [changeset('e2e-patch.md', '"e2e": patch'), changeset('core-minor.md', '"@e2e-dev/core": minor')],
    );
    assert.equal(versions.get('e2e'), '0.24.0');
    assert.equal(versions.get('@e2e-dev/core'), '0.24.0');
  });

  it('releases an unbumped fixed-group member alongside the bumped one', async () => {
    const versions = await nextReleaseVersions([e2e, core], [changeset('core-minor.md', '"@e2e-dev/core": minor')]);
    assert.equal(versions.get('e2e'), '0.24.0');
    assert.equal(versions.get('@e2e-dev/core'), '0.24.0');
  });

  it('leaves packages outside the release alone', async () => {
    const versions = await nextReleaseVersions([e2e, core, web], [changeset('web-patch.md', '"@e2e-dev/web": patch')]);
    assert.equal(versions.get('@e2e-dev/web'), '0.16.1');
    assert.equal(versions.has('e2e'), false);
    assert.equal(versions.has('@e2e-dev/core'), false);
  });

  it('does not crash on a changeset naming the version-less docs package', async () => {
    // The repro from review: a docs patch changeset made the check exit 1
    // with "Found changeset zz-x for package @e2e-dev/docs which is not
    // in the workspace", because the workspace reader skipped packages
    // without a version. Changesets skips a version-less package instead
    // of releasing it, so the plan comes back with no release for docs.
    const versions = await nextReleaseVersions(await workspacePackages(), [changeset('zz-x.md', '"@e2e-dev/docs": patch')]);
    assert.equal(versions.has('@e2e-dev/docs'), false);
  });

  it('keeps the changesets out-of-range warnings off stderr', async () => {
    // The plan prints a line per dependent whose peer does not name the
    // sibling's current version yet; on a passing run those lines read
    // as failures in the check log, so they stay inside this call.
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const versions = await nextReleaseVersions([e2e, core, web], [changeset('web-patch.md', '"@e2e-dev/web": patch')]);
      assert.equal(versions.get('@e2e-dev/web'), '0.16.1');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(errors, []);
  });

  it('throws when the changesets config is malformed instead of reading it as no fixed groups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-changesets-config-'));
    try {
      mkdirSync(join(dir, '.changeset'), { recursive: true });
      writeFileSync(join(dir, '.changeset', 'config.json'), '{not json');
      await assert.rejects(nextReleaseVersions([e2e, core], [], dir), /cannot read \.changeset\/config\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
