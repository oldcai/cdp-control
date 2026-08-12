// monitor.test.ts — daemon 定位/身份单测(注入 fetch,不启动或停止真实 daemon/browser)。
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  daemonHealthy,
  daemonIdentity,
  daemonPidFilePath,
  ensureDaemonReady,
  probeDaemonHealth,
  type DaemonIdentity,
} from '../src/monitor-health.ts';

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

test('probeDaemonHealth: 区分 current、legacy、foreign 与 unreachable', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const foreign = daemonIdentity({ CDP_HOME: join('tmp', 'other-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const legacyFetch: typeof fetch = async () => new Response(JSON.stringify({ ok: true, targets: 1 }));
  const ambiguousFetch: typeof fetch = async () => new Response(JSON.stringify({ ok: true }));
  const unreachableFetch: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  };

  assert.equal(await probeDaemonHealth(19333, expected, healthFetch(expected)), 'current');
  assert.equal(await probeDaemonHealth(19333, expected, legacyFetch), 'legacy');
  assert.equal(await probeDaemonHealth(19333, expected, ambiguousFetch), 'foreign');
  assert.equal(await probeDaemonHealth(19333, expected, healthFetch(foreign)), 'foreign');
  assert.equal(await probeDaemonHealth(19333, expected, unreachableFetch), 'unreachable');
  assert.equal(await daemonHealthy(19333, expected, legacyFetch), false);
});

test('probeDaemonHealth: legacy 只认精确旧 schema 与非负整数 targets', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const lookalikes: unknown[] = [
    { ok: true, targets: 1, service: 'worker' },
    { ok: true, targets: -1 },
    { ok: true, targets: 0.5 },
  ];

  for (const health of lookalikes) {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      return new Response(JSON.stringify(health));
    };

    assert.equal(await probeDaemonHealth(19333, expected, fakeFetch), 'foreign');
    await assert.rejects(
      ensureDaemonReady(19333, expected, {
        fetchImpl: fakeFetch,
        pollAttempts: 1,
        sleepImpl: async () => {
          calls.push('sleep');
        },
        spawnImpl: async () => {
          calls.push('spawn');
        },
      }),
      /identity|daemon|9333/i,
    );
    assert.deepEqual(calls, ['GET /health', 'GET /health']);
  }
});

test('ensureDaemonReady: legacy 先 shutdown 并等 health 消失,再 spawn 并等待 current', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  let phase: 'legacy' | 'stopping' | 'stopped' | 'starting' | 'current' = 'legacy';
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${new URL(url).pathname} (${phase})`);
    if (new URL(url).pathname === '/shutdown') {
      assert.equal(phase, 'legacy');
      phase = 'stopping';
      return new Response('{}');
    }
    if (phase === 'stopped') throw new TypeError('fetch failed');
    if (phase === 'current') {
      return new Response(JSON.stringify({ ok: true, identity: expected, targets: 0 }));
    }
    return new Response(JSON.stringify({ ok: true, targets: 1 }));
  };
  const fakeSleep = async (milliseconds: number): Promise<void> => {
    calls.push(`sleep ${milliseconds} (${phase})`);
    if (phase === 'stopping') phase = 'stopped';
    if (phase === 'starting') phase = 'current';
  };
  const fakeSpawn = async (): Promise<void> => {
    calls.push(`spawn (${phase})`);
    assert.equal(phase, 'stopped');
    phase = 'starting';
  };

  await ensureDaemonReady(19333, expected, {
    fetchImpl: fakeFetch,
    pollAttempts: 2,
    pollIntervalMs: 25,
    sleepImpl: fakeSleep,
    spawnImpl: fakeSpawn,
  });

  assert.deepEqual(calls, [
    'GET /health (legacy)',
    'GET /health (legacy)',
    'POST /shutdown (legacy)',
    'sleep 25 (stopping)',
    'GET /health (stopped)',
    'spawn (stopped)',
    'sleep 25 (starting)',
    'GET /health (current)',
  ]);
});

test('ensureDaemonReady: foreign identity 立即拒绝,绝不 shutdown 或 spawn', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const foreign = daemonIdentity({ CDP_HOME: join('tmp', 'other-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ ok: true, identity: foreign, targets: 0 }));
  };

  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: fakeFetch,
      pollAttempts: 1,
      sleepImpl: async () => {
        calls.push('sleep');
      },
      spawnImpl: async () => {
        calls.push('spawn');
      },
    }),
    /identity|daemon|9333/i,
  );
  assert.deepEqual(calls, ['GET /health']);
});
