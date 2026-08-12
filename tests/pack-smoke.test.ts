import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_PACKAGE_ROOTS,
  assertExactPackageRoots,
  packageRoots,
  parseNpmJsonArray,
} from '../scripts/pack-smoke.mjs';

test('pack 顶层白名单恰好匹配时通过', () => {
  const files = EXPECTED_PACKAGE_ROOTS.map(path => ({ path }));
  assert.deepEqual(packageRoots(files), EXPECTED_PACKAGE_ROOTS);
  assert.doesNotThrow(() => assertExactPackageRoots(packageRoots(files)));
});

test('pack 顶层白名单多一个文件时失败并指出多余项', () => {
  assert.throws(() => assertExactPackageRoots([...EXPECTED_PACKAGE_ROOTS, 'pack-drift.txt']), /多余: pack-drift\.txt/);
});

test('pack 顶层白名单少一个目录时失败并指出缺失项', () => {
  assert.throws(
    () => assertExactPackageRoots(EXPECTED_PACKAGE_ROOTS.filter(path => path !== 'skills')),
    /缺失: skills/,
  );
});

test('pack 元数据路径按跨平台分隔符归一化后只取顶层', () => {
  assert.deepEqual(
    packageRoots([{ path: 'dist/cdp.js' }, { path: 'rules\\recipes\\zhihu.js' }, { path: 'package.json' }]),
    ['dist', 'package.json', 'rules'],
  );
});

test('npm pack 的 prepare 日志混入 stdout 时仍提取末尾 JSON 数组', () => {
  assert.deepEqual(parseNpmJsonArray('🔍 build\n✅ done\n[\n  {"filename":"x.tgz","files":[]}\n]\n'), [
    { filename: 'x.tgz', files: [] },
  ]);
});
