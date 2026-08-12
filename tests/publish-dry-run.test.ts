import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertPublishChecklist,
  parseDryRunMetadata,
  publishEnvironment,
  stagePrepareWrapperSource,
} from '../scripts/publish-dry-run.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const safeManifest = {
  name: 'cdp-control',
  version: '1.0.0',
  private: true,
  scripts: { prepare: 'node build.mjs' },
};

test('publish dry-run checklist 接受 private 源包与唯一允许的 prepare hook', () => {
  assert.doesNotThrow(() => assertPublishChecklist(safeManifest));
});

test('publish dry-run checklist 拒绝已经公开的源包', () => {
  assert.throws(() => assertPublishChecklist({ ...safeManifest, private: false }), /private 必须为 true/);
});

test('publish dry-run checklist 拒绝可能借演练产生副作用的 lifecycle hook', () => {
  assert.throws(
    () => assertPublishChecklist({ ...safeManifest, scripts: { ...safeManifest.scripts, prepack: 'node leak.js' } }),
    /禁止发布 lifecycle hook: prepack/,
  );
});

test('publish dry-run 子进程环境丢弃凭据并强制 dry-run、无效 registry 与临时 npm 配置', () => {
  const environment = publishEnvironment(
    {
      PATH: '/bin',
      NPM_TOKEN: 'secret',
      NODE_AUTH_TOKEN: 'secret',
      npm_config_cert: 'client certificate',
      npm_config_key: 'client private key',
      npm_config_otp: '123456',
      npm_config_userconfig: '/real/home/.npmrc',
      SAFE_VALUE: 'kept',
    },
    {
      cache: '/tmp/cache',
      globalConfig: '/tmp/global.npmrc',
      home: '/tmp/home',
      userConfig: '/tmp/user.npmrc',
    },
  );

  assert.equal(environment.NPM_TOKEN, undefined);
  assert.equal(environment.NODE_AUTH_TOKEN, undefined);
  assert.equal(environment.npm_config_cert, undefined);
  assert.equal(environment.npm_config_key, undefined);
  assert.equal(environment.npm_config_otp, undefined);
  assert.equal(environment.SAFE_VALUE, 'kept');
  assert.equal(environment.HOME, '/tmp/home');
  assert.equal(environment.USERPROFILE, '/tmp/home');
  assert.equal(environment.npm_config_dry_run, 'true');
  assert.equal(environment.npm_config_registry, 'https://registry.invalid/');
  assert.equal(environment.npm_config_userconfig, '/tmp/user.npmrc');
  assert.equal(environment.npm_config_globalconfig, '/tmp/global.npmrc');
});

test('publish JSON 解析拒绝夹带非 JSON 前言，不猜测花括号边界', () => {
  const metadata = JSON.stringify({ id: 'cdp-control@1.0.0', name: 'cdp-control', version: '1.0.0' });
  assert.throws(
    () => parseDryRunMetadata(`🔍 tsc --noEmit {future-log-field}\n${metadata}\n`),
    /stdout 必须只包含 publish JSON/,
  );
  assert.deepEqual(parseDryRunMetadata(`${metadata}\n`), JSON.parse(metadata));
});

test('临时 stage prepare 包装器把被包装 build 的 stdout/stderr 全部物理转到 stderr', () => {
  const tmpRoot = join(repoRoot, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const fixture = mkdtempSync(join(tmpRoot, 'publish-prepare-wrapper-'));
  try {
    writeFileSync(
      join(fixture, 'build-source.mjs'),
      ["console.log('🔍 stdout build log {with-braces}');", "console.error('▶ stderr build log');"].join('\n'),
    );
    const wrapper = join(fixture, 'build.mjs');
    writeFileSync(wrapper, stagePrepareWrapperSource());

    const result = spawnSync(process.execPath, [wrapper], {
      cwd: fixture,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /🔍 stdout build log \{with-braces\}/);
    assert.match(result.stderr, /▶ stderr build log/);
  } finally {
    rmSync(fixture, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
