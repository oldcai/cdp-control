// monitor.test.ts — daemon 定位/身份单测(注入 fetch,不启动或停止真实 daemon/browser)。
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runMonitorAutostart } from '../src/monitor-diagnostics.ts';
import {
  MONITOR_INITIAL_SYNC_TIMEOUT_MS,
  MONITOR_PROCESS_BIRTH_TIMEOUT_MS,
  MONITOR_SPAWN_READY_WAIT_TIMEOUT_MS,
} from '../src/monitor-timing.ts';
import {
  DAEMON_PROTOCOL_MAJOR,
  DAEMON_PROTOCOL_MINOR,
  DAEMON_SERVICE,
  daemonHealthPayloads,
  daemonHealthy,
  daemonIdentity,
  daemonPidFilePath,
  ensureDaemonReady,
  probeDaemonHealth,
  type DaemonPollOptions,
  type DaemonIdentity,
} from '../src/monitor-health.ts';

interface VersionedHealthOptions {
  identity?: DaemonIdentity;
  major?: number;
  minor?: number;
  phase?: 'starting' | 'ready' | 'stopping';
}

function versionedHealth(expected: DaemonIdentity, options: VersionedHealthOptions = {}): Record<string, unknown> {
  return {
    service: DAEMON_SERVICE,
    protocol: {
      major: options.major ?? DAEMON_PROTOCOL_MAJOR,
      minor: options.minor ?? DAEMON_PROTOCOL_MINOR,
    },
    identity: options.identity ?? expected,
    instance: { pid: 4312, birth: 'darwin:1786567616:53026' },
    health: { phase: options.phase ?? 'ready', targets: 0 },
  };
}

function healthFetch(identity: DaemonIdentity, versioned = true): typeof fetch {
  return async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/health/v1') {
      if (!versioned) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(versionedHealth(identity)));
    }
    return new Response(JSON.stringify({ ok: true, identity, targets: 0 }));
  };
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
  const legacyFetch: typeof fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).pathname === '/health/v1'
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ ok: true, targets: 1 }));
  };
  const ambiguousFetch: typeof fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).pathname === '/health/v1'
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ ok: true }));
  };
  const unreachableFetch: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  };

  const current = await probeDaemonHealth(19333, expected, healthFetch(expected));
  assert.equal(current.kind, 'current');
  assert.equal(await probeDaemonHealth(19333, expected, legacyFetch), 'legacy');
  assert.equal(await probeDaemonHealth(19333, expected, ambiguousFetch), 'foreign');
  assert.equal(await probeDaemonHealth(19333, expected, healthFetch(foreign)), 'foreign');
  assert.equal(await probeDaemonHealth(19333, expected, unreachableFetch), 'unreachable');
  assert.equal(await daemonHealthy(19333, expected, legacyFetch), false);
});

test('probeDaemonHealth: 单次 health request 有界，超时分类为 unreachable', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const hangingFetch: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('fixture timeout', 'AbortError')), {
        once: true,
      });
    });
  const hangingBodyFetch: typeof fetch = async () => {
    const response = new Response('{}');
    Object.defineProperty(response, 'json', { value: () => new Promise<unknown>(() => {}) });
    return response;
  };
  const started = Date.now();
  assert.equal(await probeDaemonHealth(19333, expected, hangingFetch, 10), 'unreachable');
  assert.equal(await probeDaemonHealth(19333, expected, hangingBodyFetch, 10), 'foreign');
  assert.ok(Date.now() - started < 1000, 'health probe 必须在注入 timeout 后返回');
});

test('probeDaemonHealth: v1 所有层级 additive fields 与 higher minor 向后兼容', async () => {
  const expected = daemonIdentity(
    { CDP_HOME: join('tmp', '..', 'tmp', 'monitor-home') },
    join('fake', 'home'),
    '127.0.0.1',
    9222,
  );
  const payload = {
    ...versionedHealth(expected, { minor: DAEMON_PROTOCOL_MINOR + 7 }),
    kind: 'current',
    futureTopLevel: { enabled: true },
    protocol: { major: DAEMON_PROTOCOL_MAJOR, minor: DAEMON_PROTOCOL_MINOR + 7, patch: 91 },
    identity: { ...expected, futureIdentityField: 'ignored' },
    instance: { pid: 4312, birth: 'darwin:1786567616:53026', nonce: 'future' },
    health: { phase: 'ready', targets: 0, queueDepth: 4 },
  };
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${new URL(url).pathname} redirect=${init?.redirect ?? 'follow'}`);
    return new Response(JSON.stringify(payload));
  };

  const result = await probeDaemonHealth(19333, expected, fakeFetch);
  assert.equal(result.kind, 'current');
  assert.deepEqual(calls, ['/health/v1 redirect=manual']);
});

test('probeDaemonHealth: additive kind 字段不能碰撞内部判别并绕过 identity/phase', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const foreign = daemonIdentity({ CDP_HOME: join('tmp', 'foreign-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const lookalikes = [
    { ...versionedHealth(foreign), kind: 'current' },
    { ...versionedHealth(expected, { phase: 'stopping' }), kind: 'current' },
    { ...versionedHealth(expected), kind: 'incompatible', reason: 'wire field' },
  ];

  assert.equal(
    await probeDaemonHealth(19333, expected, async () => new Response(JSON.stringify(lookalikes[0]))),
    'foreign',
  );
  const transition = await probeDaemonHealth(19333, expected, async () => new Response(JSON.stringify(lookalikes[1])));
  assert.equal(transition.kind, 'transition');
  const current = await probeDaemonHealth(19333, expected, async () => new Response(JSON.stringify(lookalikes[2])));
  assert.equal(current.kind, 'current');
});

test('ensureDaemonReady: 已连接但 body 超时按 foreign fail closed，绝不 spawn', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  const hangingBodyFetch: typeof fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(new URL(url).pathname);
    const response = new Response('{}');
    Object.defineProperty(response, 'json', { value: () => new Promise<unknown>(() => {}) });
    return response;
  };
  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: hangingBodyFetch,
      pollAttempts: 1,
      requestTimeoutMs: 10,
      retireDaemonImpl: async () => calls.push('retire'),
      sleepImpl: async () => calls.push('sleep'),
      spawnImpl: async () => calls.push('spawn'),
    }),
    /占用|foreign|identity|service/i,
  );
  assert.deepEqual(calls, ['/health/v1']);
});

test('ensureDaemonReady: HTTP headers 前超时但 TCP listener 可连接时按 foreign fail closed', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  const hangingFetch: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('fixture timeout', 'AbortError')), {
        once: true,
      });
    });
  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: hangingFetch,
      listenerOccupiedImpl: async port => {
        calls.push(`connect ${port}`);
        return true;
      },
      pollAttempts: 1,
      requestTimeoutMs: 10,
      retireDaemonImpl: async () => calls.push('retire'),
      sleepImpl: async () => calls.push('sleep'),
      spawnImpl: async () => calls.push('spawn'),
    } satisfies Parameters<typeof ensureDaemonReady>[2] & DaemonPollOptions),
    /占用|foreign|identity|service/i,
  );
  assert.deepEqual(calls, ['connect 19333']);
});

test('ensureDaemonReady: HTTP reset 但 TCP listener 仍占用时按 foreign fail closed', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: async () => {
        calls.push('fetch reset');
        throw new TypeError('fetch failed: socket reset');
      },
      listenerOccupiedImpl: async port => {
        calls.push(`connect ${port}`);
        return true;
      },
      pollAttempts: 1,
      requestTimeoutMs: 10,
      retireDaemonImpl: async () => calls.push('retire'),
      sleepImpl: async () => calls.push('sleep'),
      spawnImpl: async () => calls.push('spawn'),
    }),
    /占用|foreign|identity|service/i,
  );
  assert.deepEqual(calls, ['fetch reset', 'connect 19333']);
});

test('ensureDaemonReady: TCP occupancy probe 本身异常时 fail closed，绝不 spawn', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: async () => {
        calls.push('fetch failed');
        throw new TypeError('fetch failed');
      },
      listenerOccupiedImpl: async () => {
        calls.push('connect unknown');
        throw new Error('EMFILE');
      },
      pollAttempts: 1,
      retireDaemonImpl: async () => calls.push('retire'),
      sleepImpl: async () => calls.push('sleep'),
      spawnImpl: async () => calls.push('spawn'),
    }),
    /占用|无法确认|foreign|identity|service/i,
  );
  assert.deepEqual(calls, ['fetch failed', 'connect unknown']);
});

test('probeDaemonHealth: unknown major 与 recognized malformed v1 分别是可诊断 incompatible', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const cases: Array<{ body: unknown; reason: RegExp }> = [
    {
      body: versionedHealth(expected, { major: DAEMON_PROTOCOL_MAJOR + 1 }),
      reason: /protocol major 2/i,
    },
    {
      body: { ...versionedHealth(expected), health: { phase: 'ready', targets: -1 } },
      reason: /health/i,
    },
    {
      body: { ...versionedHealth(expected), identity: { home: expected.home, cdpHost: expected.cdpHost } },
      reason: /identity/i,
    },
  ];

  for (const fixture of cases) {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(new URL(url).pathname);
      return new Response(JSON.stringify(fixture.body));
    };
    const result = await probeDaemonHealth(19333, expected, fakeFetch);
    assert.equal(result.kind, 'incompatible');
    assert.match(result.reason, fixture.reason);
    await assert.rejects(
      ensureDaemonReady(19333, expected, {
        fetchImpl: fakeFetch,
        pollAttempts: 1,
        retireDaemonImpl: async () => calls.push('retire'),
        sleepImpl: async () => calls.push('sleep'),
        spawnImpl: async () => calls.push('spawn'),
      }),
      /不兼容/i,
    );
    assert.deepEqual(calls, ['/health/v1', '/health/v1']);
  }
});

test('probeDaemonHealth: v1 仅 404 才 fallback frozen v0，redirect/错误/foreign service 都不降级', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const fallbackCalls: string[] = [];
  const fallbackFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    fallbackCalls.push(`${path} redirect=${init?.redirect}`);
    return path === '/health/v1'
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ ok: true, identity: expected, targets: 0 }));
  };
  const fallback = await probeDaemonHealth(19333, expected, fallbackFetch);
  assert.equal(fallback, 'current');
  assert.deepEqual(fallbackCalls, ['/health/v1 redirect=manual', '/health redirect=manual']);

  const noFallbackCases: Response[] = [
    new Response('{}', { status: 302, headers: { location: '/health' } }),
    new Response('{}', { status: 500 }),
    new Response(JSON.stringify({ ...versionedHealth(expected), service: 'other.worker' })),
  ];
  for (const response of noFallbackCases) {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(new URL(url).pathname);
      return response.clone();
    };
    assert.equal(await probeDaemonHealth(19333, expected, fakeFetch), 'foreign');
    assert.deepEqual(calls, ['/health/v1']);
  }
});

test('daemonHealthPayloads: frozen v0 不增字段，v1 带稳定 discriminator、instance 与 phase', () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const payloads = daemonHealthPayloads(expected, { pid: 4312, birth: 'linux:7788' }, 'ready', 3);
  assert.deepEqual(payloads.legacy, { ok: true, identity: expected, targets: 3 });
  assert.deepEqual(Object.keys(payloads.legacy), ['ok', 'identity', 'targets']);
  assert.deepEqual(payloads.versioned, {
    service: DAEMON_SERVICE,
    protocol: { major: DAEMON_PROTOCOL_MAJOR, minor: DAEMON_PROTOCOL_MINOR },
    identity: expected,
    instance: { pid: 4312, birth: 'linux:7788' },
    health: { phase: 'ready', targets: 3 },
  });
});

test('ensureDaemonReady: v1 transition 只等待，ready 后复用且绝不 retire/spawn', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  let phase: 'starting' | 'ready' = 'starting';
  const fakeFetch: typeof fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${new URL(url).pathname} (${phase})`);
    return new Response(JSON.stringify(versionedHealth(expected, { phase })));
  };

  await ensureDaemonReady(19333, expected, {
    fetchImpl: fakeFetch,
    pollAttempts: 2,
    pollIntervalMs: 7,
    retireDaemonImpl: async () => calls.push('retire'),
    sleepImpl: async milliseconds => {
      calls.push(`sleep ${milliseconds}`);
      phase = 'ready';
    },
    spawnImpl: async () => calls.push('spawn'),
  });
  assert.deepEqual(calls, ['/health/v1 (starting)', 'sleep 7', '/health/v1 (ready)']);
});

test('ensureDaemonReady: 默认 transition 窗口覆盖 birth 读取与并行 initial sync 的完整上界', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  let elapsed = 0;
  await ensureDaemonReady(19333, expected, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          versionedHealth(expected, {
            phase: elapsed >= MONITOR_PROCESS_BIRTH_TIMEOUT_MS + MONITOR_INITIAL_SYNC_TIMEOUT_MS ? 'ready' : 'starting',
          }),
        ),
      ),
    retireDaemonImpl: async () => assert.fail('transition 不得 retire'),
    sleepImpl: async milliseconds => {
      elapsed += milliseconds;
    },
    spawnImpl: async () => assert.fail('transition 不得 spawn'),
  });
  assert.ok(elapsed >= MONITOR_PROCESS_BIRTH_TIMEOUT_MS + MONITOR_INITIAL_SYNC_TIMEOUT_MS);
  assert.ok(elapsed <= MONITOR_SPAWN_READY_WAIT_TIMEOUT_MS);
});

test('ensureDaemonReady: transition 超时与 v1 stale candidate 换代都显式失败且不破坏', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9330);
  const stale = daemonIdentity({ CDP_HOME: expected.home }, join('unused', 'home'), '127.0.0.1', 9222);

  const transitionCalls: string[] = [];
  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: async input => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        transitionCalls.push(new URL(url).pathname);
        return new Response(JSON.stringify(versionedHealth(expected, { phase: 'stopping' })));
      },
      pollAttempts: 1,
      pollIntervalMs: 3,
      retireDaemonImpl: async () => transitionCalls.push('retire'),
      sleepImpl: async milliseconds => transitionCalls.push(`sleep ${milliseconds}`),
      spawnImpl: async () => transitionCalls.push('spawn'),
    }),
    /stopping|ready/i,
  );
  assert.deepEqual(transitionCalls, ['/health/v1', 'sleep 3', '/health/v1']);

  const staleCalls: string[] = [];
  let probes = 0;
  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: async input => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        staleCalls.push(new URL(url).pathname);
        probes++;
        const payload = versionedHealth(stale);
        payload.instance = { pid: 4312, birth: `linux:${probes}` };
        return new Response(JSON.stringify(payload));
      },
      pollAttempts: 1,
      retireDaemonImpl: async () => staleCalls.push('retire'),
      sleepImpl: async () => staleCalls.push('sleep'),
      spawnImpl: async () => staleCalls.push('spawn'),
    }),
    /接管|daemon|端口/i,
  );
  assert.deepEqual(staleCalls, ['/health/v1', '/health/v1']);

  const changedStale = daemonIdentity({ CDP_HOME: expected.home }, join('unused', 'home'), '127.0.0.1', 9211);
  const identityCalls: string[] = [];
  let identityProbes = 0;
  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: async input => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        identityCalls.push(new URL(url).pathname);
        identityProbes++;
        return new Response(JSON.stringify(versionedHealth(identityProbes === 1 ? stale : changedStale)));
      },
      pollAttempts: 1,
      retireDaemonImpl: async () => identityCalls.push('retire'),
      sleepImpl: async () => identityCalls.push('sleep'),
      spawnImpl: async () => identityCalls.push('spawn'),
    }),
    /接管|daemon|端口/i,
  );
  assert.deepEqual(identityCalls, ['/health/v1', '/health/v1']);
});

test('ensureDaemonReady: v1 owned-stale 将同一 health instance 传到接管门禁', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9330);
  const stale = daemonIdentity({ CDP_HOME: expected.home }, join('unused', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  let phase: 'stale' | 'stopped' | 'current' = 'stale';
  const stalePayload = versionedHealth(stale);
  stalePayload.instance = { pid: 4312, birth: 'linux:7788' };

  await ensureDaemonReady(19333, expected, {
    fetchImpl: async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${new URL(url).pathname} (${phase})`);
      if (phase === 'stopped') throw new TypeError('connection refused');
      return new Response(JSON.stringify(phase === 'current' ? versionedHealth(expected) : stalePayload));
    },
    pollAttempts: 1,
    pollIntervalMs: 5,
    retireDaemonImpl: async candidate => {
      assert.equal(typeof candidate, 'object');
      if (typeof candidate === 'object') {
        assert.equal(candidate.kind, 'owned-stale');
        assert.deepEqual(candidate.instance, { pid: 4312, birth: 'linux:7788' });
      }
      calls.push('retire verified v1 instance');
      phase = 'stopped';
    },
    sleepImpl: async milliseconds => {
      calls.push(`sleep ${milliseconds} (${phase})`);
      if (phase === 'stopped' && calls.includes('spawn')) phase = 'current';
    },
    spawnImpl: async () => {
      calls.push('spawn');
    },
  });

  assert.deepEqual(calls, [
    '/health/v1 (stale)',
    '/health/v1 (stale)',
    'retire verified v1 instance',
    'sleep 5 (stopped)',
    '/health/v1 (stopped)',
    '/health/v1 (stopped)',
    'spawn',
    'sleep 5 (stopped)',
    '/health/v1 (current)',
  ]);
});

test('ensureDaemonReady: initial unreachable 在 spawn 前复探并复用并发 current', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  let probes = 0;
  await ensureDaemonReady(19333, expected, {
    fetchImpl: async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(new URL(url).pathname);
      probes++;
      if (probes === 1) throw new TypeError('connection refused');
      return new Response(JSON.stringify(versionedHealth(expected)));
    },
    pollAttempts: 1,
    retireDaemonImpl: async () => calls.push('retire'),
    sleepImpl: async () => calls.push('sleep'),
    spawnImpl: async () => calls.push('spawn'),
  });
  assert.deepEqual(calls, ['/health/v1', '/health/v1']);
});

test('runMonitorAutostart: autostart 失败不阻塞调用者，但以稳定前缀留下诊断', async () => {
  const diagnostics: string[] = [];
  await runMonitorAutostart(
    async () => {
      throw new Error('监听端口 19333 上的 cdp-control daemon 协议不兼容: protocol major 2');
    },
    { reportError: message => diagnostics.push(message) },
  );
  assert.deepEqual(diagnostics, [
    'cdp-control monitor autostart failed: 监听端口 19333 上的 cdp-control daemon 协议不兼容: protocol major 2',
  ]);
});

test('runMonitorAutostart: disabled 保持完全禁用且不产生诊断', async () => {
  const calls: string[] = [];
  await runMonitorAutostart(
    async () => {
      calls.push('ensure');
      return 19333;
    },
    { disabled: true, reportError: message => calls.push(message) },
  );
  assert.deepEqual(calls, []);
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
      const path = new URL(url).pathname;
      return path === '/health/v1' ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(health));
    };

    assert.equal(await probeDaemonHealth(19333, expected, fakeFetch), 'foreign');
    await assert.rejects(
      ensureDaemonReady(19333, expected, {
        fetchImpl: fakeFetch,
        pollAttempts: 1,
        retireDaemonImpl: async () => {
          calls.push('retire');
        },
        sleepImpl: async () => {
          calls.push('sleep');
        },
        spawnImpl: async () => {
          calls.push('spawn');
        },
      }),
      /identity|daemon|9333/i,
    );
    assert.deepEqual(calls, ['GET /health/v1', 'GET /health', 'GET /health/v1', 'GET /health']);
  }
});

test('probeDaemonHealth: frozen v0 current 只认冻结 schema，含 nested identity exact keys', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const lookalikes: unknown[] = [
    { ok: true, identity: expected, targets: 0, service: 'worker' },
    { ok: true, identity: expected, targets: -1 },
    { ok: true, identity: expected, targets: 0.5 },
    { ok: true, identity: { ...expected, service: 'worker' }, targets: 0 },
  ];

  for (const [index, health] of lookalikes.entries()) {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      const path = new URL(url).pathname;
      return path === '/health/v1' ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(health));
    };

    assert.equal(await probeDaemonHealth(19333, expected, fakeFetch), 'foreign', `fixture ${index}`);
    await assert.rejects(
      ensureDaemonReady(19333, expected, {
        fetchImpl: fakeFetch,
        pollAttempts: 1,
        retireDaemonImpl: async () => calls.push('retire'),
        sleepImpl: async () => calls.push('sleep'),
        spawnImpl: async () => calls.push('spawn'),
      }),
      /identity|daemon|9333/i,
    );
    assert.deepEqual(calls, ['GET /health/v1', 'GET /health', 'GET /health/v1', 'GET /health']);
  }
});

test('probeDaemonHealth: health redirect 是可达 foreign,不跟随到 legacy JSON', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(url).pathname;
    calls.push(`${init?.method ?? 'GET'} ${pathname} redirect=${init?.redirect ?? 'follow'}`);
    if (pathname === '/health/v1') return new Response('{}', { status: 404 });
    if (pathname === '/health' && init?.redirect === 'manual') {
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:19444/legacy-health' } });
    }
    return new Response(JSON.stringify({ ok: true, targets: 1 }));
  };

  assert.equal(await probeDaemonHealth(19333, expected, fakeFetch), 'foreign');
  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: fakeFetch,
      pollAttempts: 1,
      retireDaemonImpl: async () => {
        calls.push('retire');
      },
      sleepImpl: async () => {
        calls.push('sleep');
      },
      spawnImpl: async () => {
        calls.push('spawn');
      },
    }),
    /identity|daemon|9333/i,
  );
  assert.deepEqual(calls, [
    'GET /health/v1 redirect=manual',
    'GET /health redirect=manual',
    'GET /health/v1 redirect=manual',
    'GET /health redirect=manual',
  ]);
});

test('ensureDaemonReady: legacy 先退出已验证 PID 并等 health 消失,再 spawn 并等待 current', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  let phase: 'legacy' | 'stopping' | 'stopped' | 'starting' | 'current' = 'legacy';
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${new URL(url).pathname} (${phase})`);
    if (phase === 'stopped') throw new TypeError('fetch failed');
    if (new URL(url).pathname === '/health/v1') return new Response('{}', { status: 404 });
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
    retireDaemonImpl: async () => {
      calls.push(`signal verified legacy pid (${phase})`);
      assert.equal(phase, 'legacy');
      phase = 'stopping';
    },
    sleepImpl: fakeSleep,
    spawnImpl: fakeSpawn,
  });

  assert.deepEqual(calls, [
    'GET /health/v1 (legacy)',
    'GET /health (legacy)',
    'GET /health/v1 (legacy)',
    'GET /health (legacy)',
    'signal verified legacy pid (legacy)',
    'sleep 25 (stopping)',
    'GET /health/v1 (stopped)',
    'GET /health/v1 (stopped)',
    'spawn (stopped)',
    'sleep 25 (starting)',
    'GET /health/v1 (current)',
    'GET /health (current)',
  ]);
});

test('ensureDaemonReady: legacy health 后端口换主时不向 foreign 发 destructive HTTP', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const foreign = daemonIdentity({ CDP_HOME: join('tmp', 'foreign-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  let phase: 'legacy' | 'foreign' = 'legacy';
  let healthGets = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${new URL(url).pathname} (${phase})`);
    if (method !== 'GET') return new Response('{}');
    if (new URL(url).pathname === '/health/v1') return new Response('{}', { status: 404 });
    if (phase === 'foreign') return new Response(JSON.stringify({ ok: true, identity: foreign, targets: 0 }));
    healthGets++;
    const response = new Response(JSON.stringify({ ok: true, targets: 1 }));
    if (healthGets === 2) phase = 'foreign';
    return response;
  };

  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: fakeFetch,
      pollAttempts: 1,
      pollIntervalMs: 1,
      retireDaemonImpl: async () => {
        calls.push(`verify legacy pid (${phase})`);
        throw new Error('legacy listener PID mismatch');
      },
      sleepImpl: async () => {
        calls.push('sleep');
      },
      spawnImpl: async () => {
        calls.push('spawn');
      },
    }),
  );
  assert.deepEqual(calls, [
    'GET /health/v1 (legacy)',
    'GET /health (legacy)',
    'GET /health/v1 (legacy)',
    'GET /health (legacy)',
    'verify legacy pid (foreign)',
  ]);
});

test('ensureDaemonReady: 同 home 旧 endpoint daemon 退出后启动 current watcher', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9330);
  const stale = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  let phase: 'stale' | 'stopping' | 'stopped' | 'starting' | 'current' = 'stale';
  const fakeFetch: typeof fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    calls.push(`GET ${path} (${phase})`);
    if (phase === 'stopped') throw new TypeError('fetch failed');
    if (path === '/health/v1') return new Response('{}', { status: 404 });
    const identity = phase === 'current' ? expected : stale;
    return new Response(JSON.stringify({ ok: true, identity, targets: 0 }));
  };

  await ensureDaemonReady(19333, expected, {
    fetchImpl: fakeFetch,
    pollAttempts: 2,
    pollIntervalMs: 1,
    retireDaemonImpl: async candidate => {
      assert.equal(typeof candidate, 'object');
      if (typeof candidate === 'object') {
        assert.equal(candidate.kind, 'owned-stale');
        assert.equal(candidate.protocol, 'v0');
        assert.deepEqual(candidate.identity, stale);
      }
      calls.push(`retire owned-stale (${phase})`);
      assert.equal(phase, 'stale');
      phase = 'stopping';
    },
    sleepImpl: async () => {
      calls.push(`sleep (${phase})`);
      if (phase === 'stopping') phase = 'stopped';
      if (phase === 'starting') phase = 'current';
    },
    spawnImpl: async () => {
      calls.push(`spawn (${phase})`);
      assert.equal(phase, 'stopped');
      phase = 'starting';
    },
  });
  assert.deepEqual(calls, [
    'GET /health/v1 (stale)',
    'GET /health (stale)',
    'GET /health/v1 (stale)',
    'GET /health (stale)',
    'retire owned-stale (stale)',
    'sleep (stopping)',
    'GET /health/v1 (stopped)',
    'GET /health/v1 (stopped)',
    'spawn (stopped)',
    'sleep (starting)',
    'GET /health/v1 (current)',
    'GET /health (current)',
  ]);
});

test('ensureDaemonReady: frozen v0 stale identity 换代时不 retire 任一候选', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9555);
  const staleA = { ...expected, cdpPort: '9333' };
  const staleB = { ...expected, cdpPort: '9444' };
  const calls: string[] = [];
  let legacyReads = 0;
  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: async input => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        calls.push(path);
        if (path === '/health/v1') return new Response('{}', { status: 404 });
        legacyReads++;
        return new Response(JSON.stringify({ ok: true, identity: legacyReads === 1 ? staleA : staleB, targets: 0 }));
      },
      pollAttempts: 1,
      retireDaemonImpl: async candidate => calls.push(`retire ${JSON.stringify(candidate)}`),
      sleepImpl: async () => calls.push('sleep'),
      spawnImpl: async () => calls.push('spawn'),
    }),
    /接管|daemon|端口/i,
  );
  assert.equal(
    calls.some(call => call.startsWith('retire')),
    false,
  );
  assert.deepEqual(calls, ['/health/v1', '/health', '/health/v1', '/health']);
});

test('ensureDaemonReady: foreign identity 立即拒绝,绝不 shutdown 或 spawn', async () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const foreign = daemonIdentity({ CDP_HOME: join('tmp', 'other-home') }, join('fake', 'home'), '127.0.0.1', 9222);
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    return new URL(url).pathname === '/health/v1'
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ ok: true, identity: foreign, targets: 0 }));
  };

  await assert.rejects(
    ensureDaemonReady(19333, expected, {
      fetchImpl: fakeFetch,
      pollAttempts: 1,
      retireDaemonImpl: async () => {
        calls.push('retire');
      },
      sleepImpl: async () => {
        calls.push('sleep');
      },
      spawnImpl: async () => {
        calls.push('spawn');
      },
    }),
    /identity|daemon|9333/i,
  );
  assert.deepEqual(calls, ['GET /health/v1', 'GET /health']);
});
