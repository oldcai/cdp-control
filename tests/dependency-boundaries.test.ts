import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkDependencyBoundaries } from '../scripts/check-dependencies.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(repoRoot, 'tmp');

interface BoundaryLayer {
  readonly name: string;
  readonly files: readonly string[];
}

function checkFixture(files: Readonly<Record<string, string>>, layers: readonly BoundaryLayer[]) {
  mkdirSync(fixtureRoot, { recursive: true });
  const rootDir = mkdtempSync(join(fixtureRoot, 'dependency-boundaries-'));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const filePath = join(rootDir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, source);
    }
    writeFileSync(
      join(rootDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          allowImportingTsExtensions: true,
          module: 'CommonJS',
          moduleResolution: 'node',
          noEmit: true,
          target: 'ES2022',
        },
        include: ['src/**/*.ts'],
      }),
    );
    return checkDependencyBoundaries({ rootDir, layers });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function errorCodes(files: Readonly<Record<string, string>>, layers: readonly BoundaryLayer[]): string[] {
  return checkFixture(files, layers).errors.map(error => error.code);
}

test('当前源码 import 图满足依赖边界', () => {
  const result = checkDependencyBoundaries({ rootDir: repoRoot });
  assert.deepEqual(result.errors, []);
  assert.ok(result.edges.length > 0);
});

test('inject 禁止导入 Node builtin', () => {
  const codes = errorCodes({ 'src/inject/bad.ts': "import { readFileSync } from 'node:fs';\n" }, []);
  assert.ok(codes.includes('inject-external-import'));
});

test('inject 禁止相对导入 Node 侧模块', () => {
  const codes = errorCodes(
    {
      'src/api.ts': 'export const api = true;\n',
      'src/inject/bad.ts': "import { api } from '../api';\nvoid api;\n",
    },
    [{ name: 'api', files: ['src/api.ts'] }],
  );
  assert.ok(codes.includes('inject-outside-import'));
});

test('Node 低层禁止反向导入高层', () => {
  const codes = errorCodes(
    {
      'src/api.ts': 'export const api = true;\n',
      'src/transport.ts': "import { api } from './api';\nvoid api;\n",
    },
    [
      { name: 'transport', files: ['src/transport.ts'] },
      { name: 'api', files: ['src/api.ts'] },
    ],
  );
  assert.ok(codes.includes('reverse-dependency'));
});

test('未归层的 Node 源文件会失败', () => {
  const codes = errorCodes({ 'src/unassigned.ts': 'export const value = true;\n' }, []);
  assert.ok(codes.includes('unassigned-node-module'));
});

test('同层允许单向依赖但禁止形成环', () => {
  const layers = [{ name: 'service', files: ['src/browser.ts', 'src/monitor.ts'] }];
  const valid = checkFixture(
    {
      'src/browser.ts': "import { monitor } from './monitor';\nvoid monitor;\n",
      'src/monitor.ts': 'export const monitor = true;\n',
    },
    layers,
  );
  assert.deepEqual(valid.errors, []);

  const invalid = checkFixture(
    {
      'src/browser.ts': "import { monitor } from './monitor';\nexport const browser = monitor;\n",
      'src/monitor.ts': "import { browser } from './browser';\nexport const monitor = browser;\n",
    },
    layers,
  );
  assert.ok(invalid.errors.some(error => error.code === 'dependency-cycle'));
});

test('type-only、import type 查询、re-export 与动态 import 都受边界约束', () => {
  const result = checkFixture(
    {
      'src/api.ts': 'export interface Api { readonly ok: boolean }\nexport const api = true;\n',
      'src/inject/bad.ts': [
        "import type { Api } from '../api';",
        "export type { Api as ExportedApi } from '../api';",
        "type QueriedApi = import('../api').Api;",
        "void import('../api');",
        'export type Pair = readonly [Api, QueriedApi];',
      ].join('\n'),
    },
    [{ name: 'api', files: ['src/api.ts'] }],
  );
  const violations = result.errors.filter(error => error.code === 'inject-outside-import');
  assert.equal(violations.length, 4);
});

test('inject 内 computed dynamic import fail closed，Node 侧 computed loader 不误报', () => {
  const injectCodes = errorCodes({ 'src/inject/bad.ts': "const path = './lib/result';\nvoid import(path);\n" }, []);
  assert.ok(injectCodes.includes('inject-computed-import'));

  const nodeResult = checkFixture(
    { 'src/recipe-runner.ts': 'export async function load(path: string) { return import(path); }\n' },
    [{ name: 'service', files: ['src/recipe-runner.ts'] }],
  );
  assert.deepEqual(nodeResult.errors, []);
});
