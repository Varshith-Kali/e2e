import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseChangesetFile } from '@changesets/parse';
import { getPackages, type Packages } from '@manypkg/get-packages';
import { collectEngineImports, hasReleaseTag, isJustVersionedFloor, loadExportFixture, nextReleaseVersions, workspacePackages } from './check-helpers.ts';
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
  it('collects imports for the sibling it is given, not e2e', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-check-helpers-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg' }));
      writeFileSync(
        join(dir, 'src', 'a.ts'),
        `import { EngineError } from '@e2e-dev/core/engine';\nimport { stepTimeout } from 'e2e/engine';\n`,
      );
      const core = collectEngineImports(join(dir, 'package.json'), '@e2e-dev/core');
      assert.deepEqual(core.get('engine'), new Map([['EngineError', 'value']]));
      assert.equal(core.size, 1);
      const e2e = collectEngineImports(join(dir, 'package.json'));
      assert.deepEqual(e2e.get('engine'), new Map([['stepTimeout', 'value']]));
      assert.equal(e2e.size, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hasReleaseTag', () => {
  it('finds a released tag and misses an unreleased version', () => {
    // A temp repo with one tag, not the live repo: the test jobs check
    // out at depth 1 with no tags, so reading the live repo's tags
    // fails there. Replacing the lookup with `false` must fail the
    // first assertion: the sibling-major announcement in
    // check-changeset-bumps.ts hangs on this call. The tag is written
    // with `git update-ref`, not `git tag`, so no global git config
    // (identity, commit hooks, signing, tag.gpgSign) can break the
    // test: `update-ref` writes the ref directly and never creates a
    // signed annotated tag, and the tag points at a blob, not a commit,
    // so no commit is ever made. `hasReleaseTag` only lists tags, and
    // listing needs no commit.
    const dir = mkdtempSync(join(tmpdir(), 'e2e-release-tag-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: dir });
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'test\n', encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', dir, 'update-ref', 'refs/tags/e2e@0.23.0', blob]);
      assert.equal(hasReleaseTag('e2e', '0.23.0', dir), true);
      assert.equal(hasReleaseTag('e2e', '99.99.99', dir), false);
      assert.equal(hasReleaseTag('@e2e-dev/docs', '0.0.0', dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('workspacePackages', () => {
  it('reads the workspace packages with their versions', async () => {
    const { packages } = await workspacePackages();
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
    const { packages } = await workspacePackages();
    const byName = new Map(packages.map((pkg) => [pkg.packageJson.name, pkg.packageJson.version]));
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'testbed', 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    assert.equal(byName.get(manifest.name), manifest.version);
  });

  it('reads the version-less docs package too: a changeset may name it', async () => {
    const { packages } = await workspacePackages();
    const docs = packages.find((pkg) => pkg.packageJson.name === '@e2e-dev/docs');
    assert.ok(docs !== undefined);
    assert.equal(docs.packageJson.version, undefined);
    assert.equal(docs.dir, join(REPO_ROOT, 'docs'));
  });
});

describe('nextReleaseVersions', () => {
  // The fixed group in the repo config: e2e and @e2e-dev/core release at
  // one version, the group's highest current version with its highest bump.
  const e2e = {
    dir: 'packages/e2e',
    packageJson: { name: 'e2e', version: '0.23.1', dependencies: { '@e2e-dev/core': 'workspace:*' } },
  };
  const core = { dir: 'packages/core', packageJson: { name: '@e2e-dev/core', version: '0.0.0' } };
  const web = {
    dir: 'packages/web',
    packageJson: { name: '@e2e-dev/web', version: '0.16.0', peerDependencies: { e2e: '>=0.23.2 <1', '@e2e-dev/core': '>=0.23.2 <1' } },
  };
  /** A manypkg `Packages` object from fixture packages, with the workspace's real tool and root package. */
  const packagesFor = async (
    fixtures: readonly { dir: string; packageJson: { name: string; version: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> } }[],
  ): Promise<Packages> => {
    const { tool, rootPackage } = await getPackages(REPO_ROOT);
    assert.ok(rootPackage !== undefined);
    return {
      rootDir: REPO_ROOT,
      rootPackage,
      packages: fixtures.map((pkg) => ({ ...pkg, relativeDir: pkg.dir })),
      tool,
    };
  };
  const changeset = (file: string, frontmatter: string) => ({
    file,
    changeset: parseChangesetFile(`---\n${frontmatter}\n---\n\nA change.\n`),
  });

  it('versions a fixed group the way changesets does: highest current version plus highest bump', async () => {
    // The repro from review: a core minor on top of the pending e2e patch
    // releases both at 0.24.0, not at the 0.23.2 the hand-rolled math gave.
    const versions = await nextReleaseVersions(
      await packagesFor([e2e, core]),
      [changeset('e2e-patch.md', '"e2e": patch'), changeset('core-minor.md', '"@e2e-dev/core": minor')],
    );
    assert.equal(versions.get('e2e'), '0.24.0');
    assert.equal(versions.get('@e2e-dev/core'), '0.24.0');
  });

  it('releases an unbumped fixed-group member alongside the bumped one', async () => {
    const versions = await nextReleaseVersions(await packagesFor([e2e, core]), [changeset('core-minor.md', '"@e2e-dev/core": minor')]);
    assert.equal(versions.get('e2e'), '0.24.0');
    assert.equal(versions.get('@e2e-dev/core'), '0.24.0');
  });

  it('leaves packages outside the release alone', async () => {
    const versions = await nextReleaseVersions(await packagesFor([e2e, core, web]), [changeset('web-patch.md', '"@e2e-dev/web": patch')]);
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
      const versions = await nextReleaseVersions(await packagesFor([e2e, core, web]), [changeset('web-patch.md', '"@e2e-dev/web": patch')]);
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
      // The config is read from the packages' root dir, so point the
      // workspace there to make readConfig hit the malformed file.
      await assert.rejects(nextReleaseVersions({ ...(await workspacePackages()), rootDir: dir }, []), /cannot read \.changeset\/config\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadExportFixture', () => {
  it('reads the committed e2e@0.15.0 fixture and misses an unfixed version', () => {
    const fixture = loadExportFixture('e2e', '0.15.0') as { package?: unknown; version?: unknown } | undefined;
    assert.equal(fixture?.package, 'e2e');
    assert.equal(fixture?.version, '0.15.0');
    assert.equal(loadExportFixture('e2e', '9.9.9'), undefined);
    assert.equal(loadExportFixture('@e2e-dev/core', '0.15.0'), undefined);
  });
});

describe('isJustVersionedFloor', () => {
  it('is true only when the sibling version is the floor and its tag does not exist yet', () => {
    assert.equal(isJustVersionedFloor('0.24.1', '0.24.1', false), true);
    assert.equal(isJustVersionedFloor('0.24.1', '0.24.1', true), false);
    assert.equal(isJustVersionedFloor('0.24.0', '0.24.1', false), false);
    assert.equal(isJustVersionedFloor(undefined, '0.24.1', false), false);
  });
});
