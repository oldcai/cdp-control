import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublishChecklist, publishEnvironment } from '../scripts/publish-dry-run.mjs';

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
