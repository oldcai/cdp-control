// paths.test.ts — CDP 数据 home 解析单测(可注入 env/home,不读写真实用户目录)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cdpHome, cdpLogsPort, cdpNoAutostart } from '../src/paths.ts';

test('cdpHome: CDP_HOME 覆盖默认用户目录', () => {
  const isolated = join('tmp', 'isolated-cdp-home');
  assert.equal(cdpHome({ CDP_HOME: isolated }, join('fake', 'home')), isolated);
});

test('cdpHome: 未设 CDP_HOME 时回落 <home>/.cdp-control', () => {
  const home = join('fake', 'home');
  assert.equal(cdpHome({}, home), join(home, '.cdp-control'));
});

test('cdpHome: 空 CDP_HOME 与未设等价', () => {
  const home = join('fake', 'home');
  assert.equal(cdpHome({ CDP_HOME: '' }, home), join(home, '.cdp-control'));
});

test('cdpNoAutostart: 仅显式值 1 禁止冷启动', () => {
  assert.equal(cdpNoAutostart({ CDP_NO_AUTOSTART: '1' }), true);
  assert.equal(cdpNoAutostart({ CDP_NO_AUTOSTART: '0' }), false);
  assert.equal(cdpNoAutostart({}), false);
});

test('cdpLogsPort: 默认 home 保持 9333,自定义 home 稳定派生隔离端口', () => {
  const fallbackHome = join('fake', 'home');
  const isolatedA = join('tmp', 'isolated-cdp-home-a');
  const isolatedB = join('tmp', 'isolated-cdp-home-b');

  assert.equal(cdpLogsPort({}, fallbackHome), 9333);
  assert.equal(cdpLogsPort({ CDP_HOME: join(fallbackHome, '.cdp-control') }, fallbackHome), 9333);
  assert.equal(cdpLogsPort({ CDP_HOME: isolatedA }, fallbackHome), cdpLogsPort({ CDP_HOME: isolatedA }, fallbackHome));
  assert.notEqual(cdpLogsPort({ CDP_HOME: isolatedA }, fallbackHome), 9333);
  assert.notEqual(
    cdpLogsPort({ CDP_HOME: isolatedA }, fallbackHome),
    cdpLogsPort({ CDP_HOME: isolatedB }, fallbackHome),
  );
});

test('cdpLogsPort: 显式 CDP_LOGS_PORT 在所有 home 下保持最高优先级', () => {
  const fallbackHome = join('fake', 'home');
  assert.equal(cdpLogsPort({ CDP_HOME: join('tmp', 'a'), CDP_LOGS_PORT: '19333' }, fallbackHome), 19333);
  assert.equal(cdpLogsPort({ CDP_HOME: join('tmp', 'b'), CDP_LOGS_PORT: '19333' }, fallbackHome), 19333);
});

test('cdpLogsPort: 非法显式端口 fail closed,不静默退回派生端口', () => {
  assert.throws(() => cdpLogsPort({ CDP_LOGS_PORT: 'not-a-port' }), /CDP_LOGS_PORT 必须是 1-65535 的整数/);
  assert.throws(() => cdpLogsPort({ CDP_LOGS_PORT: '0' }), /CDP_LOGS_PORT 必须是 1-65535 的整数/);
  assert.throws(() => cdpLogsPort({ CDP_LOGS_PORT: '65536' }), /CDP_LOGS_PORT 必须是 1-65535 的整数/);
});
