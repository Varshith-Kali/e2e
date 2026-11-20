import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addEngineImports, engineImports, type ImportKind } from './engine-exports.ts';

describe('engineImports', () => {
  it('reads named, aliased, and type-only imports from e2e entries', () => {
    const imports = engineImports(
      `import { stepTimeout, EngineError as EngineErr, type EngineDoctorCheck } from 'e2e/engine';\nimport type { StepExecutor } from 'e2e';\nimport { test as base } from 'e2e';\n`,
    );
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['stepTimeout', 'value'],
        ['EngineError', 'value'],
        ['EngineDoctorCheck', 'type'],
      ]),
    );
    assert.deepEqual(
      imports.get(''),
      new Map<string, ImportKind>([
        ['StepExecutor', 'type'],
        ['test', 'value'],
      ]),
    );
  });

  it('records a namespace import as unverifiable, not as names', () => {
    const imports = engineImports(`import * as engine from 'e2e/engine';\n`);
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['*', 'value']]));
  });

  it('records a value import of a name over a type import of the same name', () => {
    const imports = engineImports(`import { type EngineError } from 'e2e/engine';\nimport { EngineError } from 'e2e/engine';\n`);
    assert.equal(imports.get('engine')?.get('EngineError'), 'value');
  });

  it('records a value import of a name over a type import when the value comes first', () => {
    const imports = engineImports(`import { EngineError } from 'e2e/engine';\nimport { type EngineError } from 'e2e/engine';\n`);
    assert.equal(imports.get('engine')?.get('EngineError'), 'value');
  });

  it('records a side-effect import as the subpath with no names', () => {
    const imports = engineImports(`import 'e2e/nope2';\n`);
    assert.deepEqual(imports.get('nope2'), new Map<string, ImportKind>());
  });

  it('records a default-only import as the default binding', () => {
    const imports = engineImports(`import def from 'e2e/nope';\n`);
    assert.deepEqual(imports.get('nope'), new Map<string, ImportKind>([['default', 'value']]));
  });

  it('records a default import beside named imports', () => {
    const imports = engineImports(`import def, { stepTimeout } from 'e2e/engine';\n`);
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['default', 'value'],
        ['stepTimeout', 'value'],
      ]),
    );
  });

  it('records a type-only default import as a type', () => {
    const imports = engineImports(`import type def from 'e2e/engine';\n`);
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['default', 'type']]));
  });

  it('records a default imported by name', () => {
    const imports = engineImports(`import { default as def } from 'e2e/engine';\n`);
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['default', 'value']]));
  });

  it('throws when a source file fails to parse', () => {
    assert.throws(() => engineImports('export const = ;\n'), /failed to parse/);
  });

  it('ignores comments inside import lists', () => {
    const imports = engineImports(`import { stepTimeout /* the timeout */, /* leading */ EngineError, type EngineDoctorCheck // trailing\n } from 'e2e/engine';\n`);
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['stepTimeout', 'value'],
        ['EngineError', 'value'],
        ['EngineDoctorCheck', 'type'],
      ]),
    );
  });

  it('ignores an import in a JSDoc example', () => {
    const imports = engineImports(
      `/**\n * @example\n * import { x } from 'e2e/engine';\n */\nimport { stepTimeout } from 'e2e/engine';\n`,
    );
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['stepTimeout', 'value']]));
  });

  it('reads names re-exported from e2e entries as imports', () => {
    const imports = engineImports(`export { stepTimeout, type EngineDoctorCheck } from 'e2e/engine';\n`);
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['stepTimeout', 'value'],
        ['EngineDoctorCheck', 'type'],
      ]),
    );
  });

  it('records a star re-export from an e2e entry as unverifiable', () => {
    const imports = engineImports(`export * from 'e2e/engine';\n`);
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['*', 'value']]));
  });

  it('records an export-star-as re-export as the subpath with no names', () => {
    const imports = engineImports(`export * as ns from 'e2e/missing';\n`);
    assert.deepEqual(imports.get('missing'), new Map<string, ImportKind>());
  });

  it('reads names destructured from a dynamic import', () => {
    // A `type` modifier is not valid syntax in a destructuring pattern, so
    // destructured names are values.
    const imports = engineImports(`const { stepTimeout, EngineError: err } = await import('e2e/engine');\n`);
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['stepTimeout', 'value'],
        ['EngineError', 'value'],
      ]),
    );
  });

  it('records a bare dynamic import as unverifiable, not as names', () => {
    const imports = engineImports(`await import('e2e/engine');\n`);
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['*', 'value']]));
  });

  it('reads inline import types as type imports', () => {
    const imports = engineImports(
      `export type A = import('e2e/engine').EngineDoctorCheck;\nexport type B = typeof import('e2e').test;\nexport type C = import('e2e/engine').A.B;\n`,
    );
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['EngineDoctorCheck', 'type'],
        ['A', 'type'],
      ]),
    );
    assert.deepEqual(imports.get(''), new Map<string, ImportKind>([['test', 'type']]));
  });

  it('records an inline import type with no qualifier as the subpath with no names', () => {
    const imports = engineImports(`export type D = import('e2e/engine');\n`);
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>());
  });

  it('ignores imports from other packages', () => {
    assert.equal(engineImports(`import { z } from 'zod';\n`).size, 0);
  });
});

describe('engineImports with a sibling', () => {
  it('reads imports from @e2e-dev/core/engine when the sibling is core', () => {
    const imports = engineImports(
      `import { EngineError, type NodeRef } from '@e2e-dev/core/engine';\nimport { stepTimeout } from 'e2e/engine';\n`,
      '@e2e-dev/core',
    );
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['EngineError', 'value'],
        ['NodeRef', 'type'],
      ]),
    );
    assert.equal(imports.size, 1);
  });

  it('still reads only e2e imports by default', () => {
    const imports = engineImports(
      `import { EngineError } from '@e2e-dev/core/engine';\nimport { stepTimeout } from 'e2e/engine';\n`,
    );
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['stepTimeout', 'value']]));
    assert.equal(imports.size, 1);
  });
});

describe('addEngineImports', () => {
  it('keeps a value import over a type import in either order', () => {
    const typeFirst = new Map<string, Map<string, ImportKind>>();
    addEngineImports(
      typeFirst,
      new Map([['engine', new Map<string, ImportKind>([['EngineError', 'type']])]]),
    );
    addEngineImports(
      typeFirst,
      new Map([['engine', new Map<string, ImportKind>([['EngineError', 'value']])]]),
    );
    assert.equal(typeFirst.get('engine')?.get('EngineError'), 'value');
    const valueFirst = new Map<string, Map<string, ImportKind>>();
    addEngineImports(
      valueFirst,
      new Map([['engine', new Map<string, ImportKind>([['EngineError', 'value']])]]),
    );
    addEngineImports(
      valueFirst,
      new Map([['engine', new Map<string, ImportKind>([['EngineError', 'type']])]]),
    );
    assert.equal(valueFirst.get('engine')?.get('EngineError'), 'value');
  });

  it('merges names across subpaths without dropping any', () => {
    const target = new Map<string, Map<string, ImportKind>>();
    addEngineImports(
      target,
      new Map([
        ['engine', new Map<string, ImportKind>([['stepTimeout', 'value']])],
        ['runner', new Map<string, ImportKind>([['openHost', 'value']])],
      ]),
    );
    assert.deepEqual([...(target.get('engine')?.keys() ?? [])], ['stepTimeout']);
    assert.deepEqual([...(target.get('runner')?.keys() ?? [])], ['openHost']);
  });
});
