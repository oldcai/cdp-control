// paths.test.ts — CDP 数据 home 解析单测(可注入 env/home,不读写真实用户目录)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cdpHome, cdpNoAutostart } from '../src/paths.ts';

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
