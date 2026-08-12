// monitor.test.ts — daemon 定位/身份单测(注入 fetch,不启动或停止真实 daemon/browser)。
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { daemonHealthy, daemonIdentity, daemonPidFilePath, type DaemonIdentity } from '../src/monitor-health.ts';

function healthFetch(identity: DaemonIdentity): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        ok: true,
        identity,
        targets: 0,
      }),
    );
}

test('daemonPidFilePath: pid 跟随 CDP_HOME,不再共享 tmpdir 固定文件', () => {
  const fallbackHome = join('fake', 'home');
  const homeA = join('tmp', 'monitor-home-a');
  const homeB = join('tmp', 'monitor-home-b');
  const pathA = daemonPidFilePath({ CDP_HOME: homeA }, fallbackHome);
  const pathB = daemonPidFilePath({ CDP_HOME: homeB }, fallbackHome);

  assert.equal(pathA, resolve(homeA, 'cdp-listen.pid'));
  assert.equal(pathB, resolve(homeB, 'cdp-listen.pid'));
  assert.notEqual(pathA, pathB);
});

test('daemonHealthy: 仅认当前 CDP_HOME 与 CDP endpoint 都一致的 daemon', async () => {
  const fallbackHome = join('fake', 'home');
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home-a') }, fallbackHome, '127.0.0.1', 9222);
  const otherHome = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home-b') }, fallbackHome, '127.0.0.1', 9222);
  const otherHost = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home-a') }, fallbackHome, 'localhost', 9222);
  const otherPort = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home-a') }, fallbackHome, '127.0.0.1', 9555);

  assert.equal(await daemonHealthy(19333, expected, healthFetch(expected)), true);
  assert.equal(await daemonHealthy(19333, expected, healthFetch(otherHome)), false);
  assert.equal(await daemonHealthy(19333, expected, healthFetch(otherHost)), false);
  assert.equal(await daemonHealthy(19333, expected, healthFetch(otherPort)), false);
});

test('daemonHealthy: 旧版或无关 /health 即使 ok 也 fail closed', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const oldHealth: typeof fetch = async () => new Response(JSON.stringify({ ok: true, targets: 1 }));
  assert.equal(await daemonHealthy(19333, expected, oldHealth), false);
});
