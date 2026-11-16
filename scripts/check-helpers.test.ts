import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseChangesetFile } from '@changesets/parse';
import { collectEngineImports, nextReleaseVersions, workspacePackages, type ReleasePlanPackage } from './check-helpers.ts';

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

describe('workspacePackages', () => {
  it('reads the workspace packages with their versions', () => {
    const packages = workspacePackages();
    const byName = new Map(packages.map((pkg) => [pkg.packageJson.name, pkg.packageJson.version]));
    assert.equal(byName.get('e2e'), '0.23.1');
    assert.equal(byName.get('@e2e-dev/core'), '0.0.0');
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
