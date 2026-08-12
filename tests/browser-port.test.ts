/**
 * browser-port.test.ts — 固定配置端口的监听解析与回收编排单测。
 * 编排依赖全部注入：不碰真实进程，不杀真实端口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  combineAddressStates,
  prepareFixedPort,
  probeHostCdp,
  probePortAddresses,
  settleFixedPortLaunch,
  reclaimFixedPortListeners,
  parseNetstatListeners,
  parseNetstatListenersForHosts,
  parseLsofListeners,
  parseLsofListenersForHosts,
  resolveSocketHosts,
  socketHost,
  type FixedPortDependencies,
  type ProbeResult,
  type PortState,
  FixedPortLaunchAttempt,
  FixedPortError,
  hasCdpWebSocket,
  killListenerPids,
  lsofListenerArgs,
  planListenerCleanup,
  waitForCdpReady,
} from '../src/browser-port.ts';

test('hasCdpWebSocket: 只接受非空 ws/wss URL，普通 truthy 值不算健康 CDP', () => {
  assert.equal(hasCdpWebSocket({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' }), true);
  assert.equal(hasCdpWebSocket({ webSocketDebuggerUrl: 'wss://example.test/devtools/browser/x' }), true);
  assert.equal(hasCdpWebSocket({ webSocketDebuggerUrl: true }), false);
  assert.equal(hasCdpWebSocket({ webSocketDebuggerUrl: 'http://127.0.0.1:9222/not-cdp' }), false);
  assert.equal(hasCdpWebSocket({ webSocketDebuggerUrl: '   ' }), false);
});

test('lsofListenerArgs: POSIX 枚举只请求精确 TCP LISTEN，不会收客户端连接或 UDP', () => {
  assert.deepEqual(lsofListenerArgs(9222), ['-nP', '-iTCP:9222', '-sTCP:LISTEN', '-Fpnt']);
});

test('FixedPortLaunchAttempt: 未 spawn 的本轮清理不碰历史进程，record 后只清理本轮句柄', () => {
  const historical = { pid: 401 };
  const current = { pid: 402 };
  const killed: Array<{ pid: number }> = [];
  const attempt = new FixedPortLaunchAttempt<{ pid: number }>();

  attempt.cleanup(process => killed.push(process));
  assert.deepEqual(killed, []);
  assert.deepEqual(historical, { pid: 401 });

  const launched = attempt.record(current);
  attempt.release(historical);
  assert.equal(attempt.launched, current);
  attempt.release(current);
  assert.equal(attempt.launched, null);
  assert.equal(launched, current, '释放终止所有权后仍须保留本轮 waitReady 的精确句柄');

  attempt.record(current);
  attempt.cleanup(process => killed.push(process));
  assert.deepEqual(killed, [current]);
  assert.equal(attempt.launched, null);
});

test('FixedPortLaunchAttempt: 子进程即时退出后释放 kill 归属，但保留精确 waitReady 句柄', () => {
  const exited = { pid: 403 };
  const attempt = new FixedPortLaunchAttempt<{ pid: number }>();

  const waitHandle = attempt.record(exited);
  attempt.release(exited);

  assert.equal(attempt.launched, null);
  assert.equal(waitHandle, exited);
});

test('socketHost: bracketed IPv6 仅 URL 保留括号，socket bind/connect 使用裸地址', () => {
  assert.equal(socketHost('[::1]'), '::1');
  assert.equal(socketHost('127.0.0.1'), '127.0.0.1');
});

test('resolveSocketHosts: DNS 主机使用 all:true 保留所有去重地址', async () => {
  const calls: Array<{ hostname: string; options: { all: true } }> = [];
  const hosts = await resolveSocketHosts('browser.test', async (hostname, options) => {
    calls.push({ hostname, options });
    return [{ address: '192.0.2.44' }, { address: '2001:0db8:0:0:0:0:0:44' }, { address: '192.0.2.44' }];
  });
  assert.deepEqual(calls, [{ hostname: 'browser.test', options: { all: true } }]);
  assert.deepEqual(hosts, ['192.0.2.44', '2001:db8::44']);
});

test('probeHostCdp: 主连接未就绪时复用其他解析地址的健康 CDP', async () => {
  const calls: string[] = [];
  assert.deepEqual(
    await probeHostCdp({
      primary: async () => {
        calls.push('primary');
        return { ready: false };
      },
      resolveAddresses: async () => {
        calls.push('resolve');
        return ['192.0.2.44', '2001:db8::44'];
      },
      address: async host => {
        calls.push(`address:${host}`);
        return host === '2001:db8::44' ? { ready: true, browser: 'Chrome/healthy-other-address' } : { ready: false };
      },
    }),
    { ready: true, browser: 'Chrome/healthy-other-address', address: '2001:db8::44' },
  );
  assert.deepEqual(calls, ['primary', 'resolve', 'address:192.0.2.44', 'address:2001:db8::44']);
});

test('probeHostCdp: 原始 host 已是单一数值地址时只做一次探活并带回该地址', async () => {
  const calls: string[] = [];
  assert.deepEqual(
    await probeHostCdp({
      originalHost: '127.0.0.1',
      primary: async () => {
        calls.push('primary');
        return { ready: true, browser: 'Chrome/primary' };
      },
      resolveAddresses: async () => {
        calls.push('resolve');
        return ['127.0.0.1'];
      },
      address: async host => {
        calls.push(`address:${host}`);
        return { ready: false };
      },
    }),
    { ready: true, browser: 'Chrome/primary', address: '127.0.0.1' },
  );
  assert.deepEqual(calls, ['primary', 'resolve']);
});

test('probeHostCdp: DNS hostname 即使只解析到一个地址也必须验证后再 pin', async () => {
  const calls: string[] = [];
  assert.deepEqual(
    await probeHostCdp({
      originalHost: 'cdp.example.test',
      primary: async () => {
        calls.push('primary');
        return { ready: true, browser: 'Chrome/hostname' };
      },
      resolveAddresses: async () => {
        calls.push('resolve');
        return ['192.0.2.99'];
      },
      address: async host => {
        calls.push(`address:${host}`);
        return host === '192.0.2.99' ? { ready: true, browser: 'Chrome/verified-single' } : { ready: false };
      },
    }),
    { ready: true, browser: 'Chrome/verified-single', address: '192.0.2.99' },
  );
  assert.deepEqual(calls, ['primary', 'resolve', 'address:192.0.2.99']);
});

test('probeHostCdp: DNS 单地址无法验证主探活时 fail closed，不得 pin 未验证地址', async () => {
  await assert.rejects(
    () =>
      probeHostCdp({
        originalHost: 'cdp.example.test',
        primary: async () => ({ ready: true, browser: 'Chrome/hostname' }),
        resolveAddresses: async () => ['192.0.2.99'],
        address: async () => ({ ready: false }),
      }),
    error => error instanceof FixedPortError && /未能把健康 CDP 归属/.test(error.message),
  );
});

test('probeHostCdp: primary 未就绪时 pinned resolver 的 FixedPortError 仍立即传播', async () => {
  const dnsChanged = new FixedPortError('pinned DNS set changed fixture');
  let addressProbeCalled = false;

  await assert.rejects(
    () =>
      probeHostCdp({
        originalHost: 'cdp.example.test',
        primary: async () => ({ ready: false }),
        resolveAddresses: async () => {
          throw dnsChanged;
        },
        address: async () => {
          addressProbeCalled = true;
          return { ready: false };
        },
      }),
    error => error === dnsChanged,
  );
  assert.equal(addressProbeCalled, false);
});

test('probeHostCdp: 主连接健康但多地址中仅后一个是 CDP 时必须 pin 该数值地址', async () => {
  const calls: string[] = [];
  assert.deepEqual(
    await probeHostCdp({
      primary: async () => {
        calls.push('primary');
        return { ready: true, browser: 'Chrome/hostname' };
      },
      resolveAddresses: async () => {
        calls.push('resolve');
        return ['192.0.2.44', '2001:db8::44'];
      },
      address: async host => {
        calls.push(`address:${host}`);
        return host === '2001:db8::44' ? { ready: true, browser: 'Chrome/healthy-other-address' } : { ready: false };
      },
    }),
    { ready: true, browser: 'Chrome/healthy-other-address', address: '2001:db8::44' },
  );
  assert.deepEqual(calls, ['primary', 'resolve', 'address:192.0.2.44', 'address:2001:db8::44']);
});

test('probeHostCdp: 主连接健康却无法归属到任一解析地址时 fail closed', async () => {
  await assert.rejects(
    () =>
      probeHostCdp({
        primary: async () => ({ ready: true, browser: 'Chrome/hostname' }),
        resolveAddresses: async () => ['192.0.2.44', '2001:db8::44'],
        address: async () => ({ ready: false }),
      }),
    error => error instanceof FixedPortError && /未能把健康 CDP 归属/.test(error.message),
  );
});

test('probePortAddresses: localhost 所有地址都逐一 connect 再逐一 bind', async () => {
  const calls: string[] = [];
  const hosts = await resolveSocketHosts('localhost', async () => {
    throw new Error('localhost 不应调 DNS');
  });
  assert.deepEqual(
    await probePortAddresses(9222, hosts, {
      connect: async (port, address) => {
        calls.push(`connect:${address}:${port}`);
        return { address, state: 'free' };
      },
      bind: async (port, address) => {
        calls.push(`bind:${address}:${port}`);
        return { address, state: 'free' };
      },
    }),
    { state: 'free' },
  );
  assert.deepEqual(calls, ['connect:127.0.0.1:9222', 'connect:::1:9222', 'bind:127.0.0.1:9222', 'bind:::1:9222']);
});

test('combineAddressStates: localhost 跳过关闭的 IPv6 地址族，保留 IPv4 空闲结论', () => {
  assert.deepEqual(
    combineAddressStates([
      { address: '127.0.0.1', state: 'free' },
      { address: '::1', state: 'unknown', code: 'EAFNOSUPPORT', reason: 'connect ::1 EAFNOSUPPORT' },
    ]),
    { state: 'free' },
  );
});

test('combineAddressStates: 任一非可忽略 unknown 都压过 busy，阻止破坏性回收', () => {
  assert.deepEqual(
    combineAddressStates([
      { address: '127.0.0.1', state: 'busy' },
      { address: '192.0.2.44', state: 'unknown', code: 'EACCES', reason: 'connect 192.0.2.44:9222 EACCES' },
    ]),
    { state: 'unknown', reason: 'connect 192.0.2.44:9222 EACCES' },
  );
  assert.deepEqual(
    combineAddressStates([
      { address: '127.0.0.1', state: 'busy' },
      { address: '::1', state: 'unknown', code: 'EAFNOSUPPORT', reason: 'connect ::1 EAFNOSUPPORT' },
    ]),
    { state: 'busy' },
  );
});

test('waitForCdpReady: 子进程早退后对并发 CDP 有界复探，但保留早退交由状态机分类', async () => {
  let now = 0;
  let probes = 0;
  await assert.rejects(
    () =>
      waitForCdpReady(
        {
          probe: async () => ++probes === 3,
          exitReason: () => 'fixture child exited(code=0)',
          sleep: async ms => {
            now += ms;
          },
          now: () => now,
        },
        20_000,
        3_000,
        1_000,
      ),
    /fixture child exited\(code=0\)/,
  );
  assert.equal(probes, 3);
  assert.equal(now, 2_000);
});

test('waitForCdpReady: probe 错误可重试，但地址身份 guard 变化必须立即 fail closed', async () => {
  const dnsChanged = new Error('DNS changed during launch wait fixture');
  let slept = false;

  await assert.rejects(
    () =>
      waitForCdpReady(
        {
          probe: async () => {
            throw new Error('transient probe fixture');
          },
          exitReason: () => null,
          assertEndpoint: () => {
            throw dnsChanged;
          },
          sleep: async () => {
            slept = true;
          },
          now: () => 0,
        },
        20_000,
      ),
    error => error === dnsChanged,
  );
  assert.equal(slept, false);
});

test('settleFixedPortLaunch: exact child 早退后并发 CDP 就绪必须分类为 reuse', async () => {
  let now = 0;
  let waitProbes = 0;
  const d = dependencies({ probes: [{ ready: true, browser: 'Chrome/concurrent-owner' }] });

  const result = await settleFixedPortLaunch(
    24129,
    () =>
      waitForCdpReady(
        {
          probe: async () => ++waitProbes === 3,
          exitReason: () => 'fixture exact child exited(code=0)',
          sleep: async ms => {
            now += ms;
          },
          now: () => now,
        },
        20_000,
        3_000,
        1_000,
      ),
    d,
  );

  assert.deepEqual(result, { action: 'reuse', browser: 'Chrome/concurrent-owner' });
  assert.deepEqual(d.calls, ['probe:24129']);
});

test('settleFixedPortLaunch: waitReady 成功后地址身份变化必须 fail closed，不能误报 launch', async () => {
  const dnsChanged = new Error('DNS changed after launch readiness fixture');
  let checks = 0;

  await assert.rejects(
    () =>
      settleFixedPortLaunch(24132, async () => undefined, {
        assertAddressSet: () => {
          checks += 1;
          throw dnsChanged;
        },
        probe: async () => ({ ready: false }),
        portState: async () => ({ state: 'free' }),
        listenerPids: async () => [],
        killPid: () => undefined,
        sleep: async () => undefined,
      }),
    error => error === dnsChanged,
  );
  assert.equal(checks, 2, '失败恢复也必须沿用同一地址 guard，而不是换快照继续');
});

test('settleFixedPortLaunch: async 地址复核期间配置改口时不得返回 launch', async () => {
  const authorityChanged = new Error('authority changed during settle address guard fixture');
  let authoritative = true;

  await assert.rejects(
    () =>
      settleFixedPortLaunch(24135, async () => undefined, {
        assertAuthority: () => {
          if (!authoritative) throw authorityChanged;
        },
        assertAddressSet: async () => {
          authoritative = false;
        },
        probe: async () => ({ ready: false }),
        portState: async () => ({ state: 'free' }),
        listenerPids: async () => [],
        killPid: () => undefined,
        sleep: async () => undefined,
      }),
    error => error === authorityChanged,
  );
});

test('waitForCdpReady: 早退宽限结束仍无健康 CDP 时保留真实退出原因', async () => {
  let now = 0;
  await assert.rejects(
    () =>
      waitForCdpReady(
        {
          probe: async () => false,
          exitReason: () => 'fixture child exited(code=7)',
          sleep: async ms => {
            now += ms;
          },
          now: () => now,
        },
        20_000,
        3_000,
        1_000,
      ),
    /code=7/,
  );
  assert.equal(now, 3_000);
});

test('killListenerPids: 单个 listener 结束失败仍尝试其余 PID，并聚合真因', async () => {
  const attempted: number[] = [];
  const failures = await killListenerPids(
    [711, 712],
    pid => {
      attempted.push(pid);
      if (pid === 711) throw new Error('EPERM fixture');
    },
    () => undefined,
  );
  assert.deepEqual(attempted, [711, 712]);
  assert.deepEqual(failures, ['711: EPERM fixture']);
});

test('planListenerCleanup: 端点空闲时不枚举、更不误杀另一地址族 wildcard listener', async () => {
  const calls: string[] = [];
  const plan = await planListenerCleanup(9222, {
    portState: async () => {
      calls.push('state');
      return { state: 'free' };
    },
    listenerPids: async () => {
      calls.push('listeners');
      return [888];
    },
  });
  assert.deepEqual(plan, { action: 'noProcess' });
  assert.deepEqual(calls, ['state']);
});

test('planListenerCleanup: 只有端点持续 busy 且 PID 快照稳定才允许 kill', async () => {
  const states: PortState[] = [{ state: 'busy' }, { state: 'busy' }];
  const listeners = [
    [901, 902, 901],
    [902, 901],
  ];
  assert.deepEqual(
    await planListenerCleanup(9222, {
      portState: async () => states.shift() ?? { state: 'busy' },
      listenerPids: async () => listeners.shift() ?? [],
    }),
    { action: 'kill', pids: [902, 901] },
  );
});

test('planListenerCleanup: 端点 busy 但 PID 快照换代时 fail closed', async () => {
  const listeners = [[911], [912]];
  assert.deepEqual(
    await planListenerCleanup(9222, {
      portState: async () => ({ state: 'busy' }),
      listenerPids: async () => listeners.shift() ?? [],
    }),
    { action: 'stillUp' },
  );
});

test('planListenerCleanup: 异步枚举期间权威配置变化时立即中止', async () => {
  const authorityChanged = new Error('kill authority changed fixture');
  let authoritative = true;
  const calls: string[] = [];

  await assert.rejects(
    () =>
      planListenerCleanup(9222, {
        assertAuthority: () => {
          calls.push(`authority:${authoritative}`);
          if (!authoritative) throw authorityChanged;
        },
        portState: async () => {
          calls.push('state');
          return { state: 'busy' };
        },
        listenerPids: async () => {
          calls.push('listeners');
          authoritative = false;
          return [921];
        },
      }),
    error => error === authorityChanged,
  );
  assert.deepEqual(calls, [
    'authority:true',
    'authority:true',
    'state',
    'authority:true',
    'authority:true',
    'listeners',
    'authority:false',
  ]);
});

test('reclaimFixedPortListeners: 权威配置已变化时在首个 kill 前 fail closed', async () => {
  const authorityChanged = new Error('kill authority changed before destructive operation fixture');
  const killed: number[] = [];
  await assert.rejects(
    () =>
      reclaimFixedPortListeners(9222, [931, 932], {
        assertAuthority: () => {
          throw authorityChanged;
        },
        listenerPids: async () => [931, 932],
        killPid: pid => killed.push(pid),
        portState: async () => ({ state: 'free' }),
        sleep: async () => {},
      }),
    error => error === authorityChanged,
  );
  assert.deepEqual(killed, []);
});

test('prepareFixedPort: 破坏性门禁的 DNS 地址集合变化时 fail closed，绝不 kill', async () => {
  const dnsChanged = new Error('DNS address set changed fixture');
  const killed: number[] = [];
  let addressSet = '192.0.2.10,192.0.2.11';
  const assertAddressSet = (): void => {
    if (addressSet !== '192.0.2.10,192.0.2.11') throw dnsChanged;
  };

  await assert.rejects(
    () =>
      prepareFixedPort(24130, {
        probe: async () => ({ ready: false }),
        portState: async () => ({ state: 'busy' }),
        listenerPids: async () => {
          addressSet = '192.0.2.12';
          return [941];
        },
        assertAddressSet,
        killPid: pid => killed.push(pid),
        sleep: async () => undefined,
      }),
    error => error === dnsChanged,
  );
  assert.deepEqual(killed, []);
});

test('reclaimFixedPortListeners: 杀前复确认 PID 仍是当前 listener，已退出或换代则 fail closed 不杀', async () => {
  const killed: number[] = [];
  await assert.rejects(
    () =>
      reclaimFixedPortListeners(9222, [961, 962], {
        listenerPids: async () => [961],
        killPid: pid => {
          killed.push(pid);
        },
        portState: async () => ({ state: 'busy' }),
        sleep: async () => undefined,
      }),
    error => error instanceof FixedPortError && /监听进程身份已变化.*PID 962/.test(error.message),
  );
  assert.deepEqual(killed, [961]);
});

test('reclaimFixedPortListeners: 每个 PID 前复核 DNS 地址集合，变化后不再 kill 后续 listener', async () => {
  const dnsChanged = new Error('DNS address set changed between PIDs fixture');
  const killed: number[] = [];
  let addressSetChanged = false;

  await assert.rejects(
    () =>
      reclaimFixedPortListeners(24131, [951, 952], {
        assertAddressSet: () => {
          if (addressSetChanged) throw dnsChanged;
        },
        listenerPids: async () => [951, 952],
        killPid: pid => {
          killed.push(pid);
          addressSetChanged = true;
        },
        portState: async () => ({ state: 'busy' }),
        sleep: async () => undefined,
      }),
    error => error === dnsChanged,
  );
  assert.deepEqual(killed, [951]);
});

test('reclaimFixedPortListeners: 异步 guard 期间 listener PID 被替换时 fail closed，不 kill 旧 PID', async () => {
  const killed: number[] = [];
  let currentListeners = [961];
  const deps = {
    assertAddressSet: async () => {
      currentListeners = [1961];
    },
    listenerPids: async () => currentListeners,
    killPid: (pid: number) => killed.push(pid),
    portState: async () => ({ state: 'free' }) satisfies PortState,
    sleep: async () => undefined,
  };

  await assert.rejects(
    () => reclaimFixedPortListeners(24133, [961], deps),
    error => error instanceof FixedPortError && /监听进程身份已变化/.test(error.message),
  );
  assert.deepEqual(killed, []);
});

test('reclaimFixedPortListeners: listener 快照期间 DNS 集合变化时在 kill 前 fail closed', async () => {
  const dnsChanged = new Error('DNS changed during listener snapshot fixture');
  const killed: number[] = [];
  let addressChecks = 0;

  await assert.rejects(
    () =>
      reclaimFixedPortListeners(24134, [971], {
        assertAddressSet: async () => {
          addressChecks += 1;
          if (addressChecks === 2) throw dnsChanged;
        },
        listenerPids: async () => [971],
        killPid: pid => killed.push(pid),
        portState: async () => ({ state: 'free' }),
        sleep: async () => undefined,
      }),
    error => error === dnsChanged,
  );
  assert.deepEqual(killed, []);
});

function dependencies(
  options: {
    probes?: ProbeResult[];
    busyGraceProbes?: ProbeResult[];
    states?: PortState[];
    listeners?: number[][];
    killError?: Error;
  } = {},
): FixedPortDependencies & { calls: string[] } {
  const calls: string[] = [];
  const probes = [...(options.probes ?? [{ ready: false }])];
  const busyGraceProbes = options.busyGraceProbes ? [...options.busyGraceProbes] : null;
  const states = [...(options.states ?? [{ state: 'free' }])];
  const listeners = [...(options.listeners ?? [])];
  return {
    calls,
    probe: async port => {
      calls.push(`probe:${port}`);
      return probes.shift() ?? { ready: false };
    },
    ...(busyGraceProbes
      ? {
          busyGraceProbe: async (port: number) => {
            calls.push(`grace:${port}`);
            return busyGraceProbes.shift() ?? { ready: false };
          },
        }
      : {}),
    portState: async port => {
      calls.push(`state:${port}`);
      if (states.length > 1) return states.shift()!;
      return states[0] ?? { state: 'free' };
    },
    listenerPids: async port => {
      calls.push(`listeners:${port}`);
      if (listeners.length > 1) return listeners.shift()!;
      return listeners[0] ?? [];
    },
    killPid: pid => {
      calls.push(`kill:${pid}`);
      if (options.killError) throw options.killError;
    },
    sleep: async ms => {
      calls.push(`sleep:${ms}`);
    },
    releaseTimeoutMs: 600,
    releasePollMs: 200,
  };
}

test('prepareFixedPort: 健康 CDP 直接复用，不查监听、不 kill', async () => {
  const d = dependencies({ probes: [{ ready: true, browser: 'Chrome/1' }] });
  assert.deepEqual(await prepareFixedPort(24101, d), { action: 'reuse', browser: 'Chrome/1' });
  assert.deepEqual(d.calls, ['probe:24101']);
});

test('prepareFixedPort: async 地址复核期间配置改口时不得消费旧 probe 返回 reuse', async () => {
  const authorityChanged = new Error('authority changed during probe address guard fixture');
  let authoritative = true;
  let addressChecks = 0;

  await assert.rejects(
    () =>
      prepareFixedPort(24136, {
        assertAuthority: () => {
          if (!authoritative) throw authorityChanged;
        },
        assertAddressSet: async () => {
          addressChecks += 1;
          if (addressChecks === 2) authoritative = false;
        },
        probe: async () => ({ ready: true, browser: 'Chrome/stale-authority' }),
        portState: async () => ({ state: 'free' }),
        listenerPids: async () => [],
        killPid: () => undefined,
        sleep: async () => undefined,
      }),
    error => error === authorityChanged,
  );
});

test('prepareFixedPort: 端口空闲就在同一个配置端口启动', async () => {
  const d = dependencies({ probes: [{ ready: false }], states: [{ state: 'free' }] });
  assert.deepEqual(await prepareFixedPort(24102, d), { action: 'launch', port: 24102 });
  assert.deepEqual(d.calls, ['probe:24102', 'state:24102']);
});

test('prepareFixedPort: 忙端口先给并发冷启动就绪宽限；宽限内变健康则复用且不枚举或 kill', async () => {
  const d = dependencies({
    probes: [{ ready: false }],
    busyGraceProbes: [{ ready: true, browser: 'Chrome/grace' }],
    states: [{ state: 'busy' }],
  });
  assert.deepEqual(await prepareFixedPort(24119, d), { action: 'reuse', browser: 'Chrome/grace' });
  assert.deepEqual(d.calls, ['probe:24119', 'state:24119', 'grace:24119']);
});

test('prepareFixedPort: 忙端口宽限期间权威端口改变时在 listener 枚举和 kill 前中止', async () => {
  const authorityChanged = new Error('authority changed fixture');
  const d = dependencies({
    probes: [{ ready: false }],
    busyGraceProbes: [{ ready: false }],
    states: [{ state: 'busy' }],
    listeners: [[581]],
  });
  let authoritativePort = 24123;
  d.assertAuthority = port => {
    d.calls.push(`authority:${port}->${authoritativePort}`);
    if (port !== authoritativePort) throw authorityChanged;
  };
  d.busyGraceProbe = async port => {
    d.calls.push(`grace:${port}`);
    authoritativePort = 25123;
    return { ready: false };
  };

  await assert.rejects(
    () => prepareFixedPort(24123, d),
    error => error === authorityChanged,
  );
  assert.ok(!d.calls.some(call => call.startsWith('listeners:') || call.startsWith('kill:')));
  assert.equal(d.calls.at(-1), 'authority:24123->25123');
});

test('settleFixedPortLaunch: 启动器早退后重进固定端口判断；并发 CDP 在宽限内就绪则复用', async () => {
  const d = dependencies({
    probes: [{ ready: false }],
    busyGraceProbes: [{ ready: true, browser: 'Chrome/post-exit-race' }],
    states: [{ state: 'busy' }],
  });
  const earlyExit = new Error('浏览器进程在 CDP 就绪前退出(code=0, signal=null)');
  const result = await settleFixedPortLaunch(
    24120,
    async () => {
      d.calls.push('waitReady');
      throw earlyExit;
    },
    d,
  );
  assert.deepEqual(result, { action: 'reuse', browser: 'Chrome/post-exit-race' });
  assert.deepEqual(d.calls, ['waitReady', 'probe:24120', 'state:24120', 'grace:24120']);
});

test('settleFixedPortLaunch: 启动器早退且端口仍空闲时保留原始退出真因，不重复 spawn', async () => {
  const d = dependencies({ probes: [{ ready: false }], states: [{ state: 'free' }] });
  const earlyExit = new Error('code=7 fixture');
  await assert.rejects(
    () =>
      settleFixedPortLaunch(
        24121,
        async () => {
          d.calls.push('waitReady');
          throw earlyExit;
        },
        d,
      ),
    error => error === earlyExit,
  );
  assert.deepEqual(d.calls, ['waitReady', 'probe:24121', 'state:24121']);
  assert.ok(!d.calls.some(call => call.startsWith('launch:')));
});

test('prepareFixedPort: 注入 launch 时启动前再检查；并发变健康就复用且不 spawn', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: true, browser: 'Chrome/free-race' }],
    states: [{ state: 'free' }],
  });
  d.launch = async port => {
    d.calls.push(`launch:${port}`);
  };
  assert.deepEqual(await prepareFixedPort(24112, d), { action: 'reuse', browser: 'Chrome/free-race' });
  assert.deepEqual(d.calls, ['probe:24112', 'state:24112', 'probe:24112']);
});

test('prepareFixedPort: 注入 launch 时两次确认空闲才在原配置端口 spawn', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }, { ready: false }],
    states: [{ state: 'free' }, { state: 'free' }],
  });
  d.launch = async port => {
    d.calls.push(`launch:${port}`);
  };
  assert.deepEqual(await prepareFixedPort(24113, d), { action: 'launch', port: 24113 });
  assert.deepEqual(d.calls, ['probe:24113', 'state:24113', 'probe:24113', 'state:24113', 'launch:24113']);
});

test('prepareFixedPort: 最终空闲检查期间权威端口改变时在 spawn 前中止', async () => {
  const authorityChanged = new Error('authority changed before spawn fixture');
  const calls: string[] = [];
  let authoritativePort = 24124;
  let stateCount = 0;
  const d: FixedPortDependencies = {
    probe: async port => {
      calls.push(`probe:${port}`);
      return { ready: false };
    },
    portState: async port => {
      calls.push(`state:${port}`);
      stateCount++;
      if (stateCount === 2) authoritativePort = 25124;
      return { state: 'free' };
    },
    listenerPids: async () => [],
    killPid: () => undefined,
    launch: async port => {
      calls.push(`launch:${port}`);
    },
    assertAuthority: port => {
      calls.push(`authority:${port}->${authoritativePort}`);
      if (port !== authoritativePort) throw authorityChanged;
    },
    sleep: async () => undefined,
  };

  await assert.rejects(
    () => prepareFixedPort(24124, d),
    error => error === authorityChanged,
  );
  assert.ok(!calls.some(call => call.startsWith('launch:')));
  assert.equal(calls.at(-1), 'authority:24124->25124');
});

test('prepareFixedPort: 忙且非健康时 kill 全部去重 listener，确认释放后仍启动配置端口', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }],
    busyGraceProbes: [{ ready: false }],
    states: [{ state: 'busy' }, { state: 'busy' }, { state: 'free' }],
    listeners: [
      [501, 502, 501],
      [501, 502],
      [502, 501],
    ],
  });
  assert.deepEqual(await prepareFixedPort(24103, d), { action: 'launch', port: 24103 });
  assert.deepEqual(d.calls, [
    'probe:24103',
    'state:24103',
    'grace:24103',
    'listeners:24103',
    'probe:24103',
    'state:24103',
    'listeners:24103',
    'probe:24103',
    'listeners:24103',
    'listeners:24103',
    'listeners:24103',
    'kill:502',
    'listeners:24103',
    'listeners:24103',
    'kill:501',
    'state:24103',
  ]);
});

test('prepareFixedPort: kill 前最终复探若并发变健康则复用且不 kill', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: true, browser: 'Edge/2' }],
    states: [{ state: 'busy' }, { state: 'busy' }],
    listeners: [[601], [601]],
  });
  assert.deepEqual(await prepareFixedPort(24104, d), { action: 'reuse', browser: 'Edge/2' });
  assert.deepEqual(d.calls, ['probe:24104', 'state:24104', 'listeners:24104', 'probe:24104']);
});

test('prepareFixedPort: 最终复探后 listener 集变化则重启判断，不杀旧 PID', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }, { ready: true, browser: 'Chrome/race' }],
    states: [{ state: 'busy' }, { state: 'busy' }],
    listeners: [[611], [612]],
  });
  assert.deepEqual(await prepareFixedPort(24110, d), { action: 'reuse', browser: 'Chrome/race' });
  assert.deepEqual(d.calls, [
    'probe:24110',
    'state:24110',
    'listeners:24110',
    'probe:24110',
    'state:24110',
    'listeners:24110',
    'probe:24110',
  ]);
  assert.ok(!d.calls.some(call => call.startsWith('kill:')));
});

test('prepareFixedPort: 最终健康探测期间 listener 换代则重新判断，不杀探测前的旧 PID', async () => {
  const calls: string[] = [];
  let listenerPid = 621;
  let probeCount = 0;
  const d: FixedPortDependencies = {
    probe: async () => {
      probeCount++;
      calls.push(`probe:${probeCount}`);
      if (probeCount === 3) listenerPid = 622;
      return probeCount === 4 ? { ready: true, browser: 'Chrome/post-probe-race' } : { ready: false };
    },
    portState: async () => ({ state: 'busy' }),
    listenerPids: async () => {
      calls.push(`listeners:${listenerPid}`);
      return [listenerPid];
    },
    killPid: pid => {
      calls.push(`kill:${pid}`);
    },
    sleep: async () => undefined,
    releaseTimeoutMs: 0,
    releasePollMs: 100,
  };
  assert.deepEqual(await prepareFixedPort(24116, d), { action: 'reuse', browser: 'Chrome/post-probe-race' });
  assert.ok(!calls.some(call => call.startsWith('kill:')));
});

test('prepareFixedPort: 找不到可归属 listener 且端点仍忙时明确失败，不 launch', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }, { ready: false }],
    states: [{ state: 'busy' }, { state: 'busy' }],
    listeners: [[]],
  });
  await assert.rejects(() => prepareFixedPort(24105, d), /端口 24105.*监听进程/);
  assert.deepEqual(d.calls, ['probe:24105', 'state:24105', 'listeners:24105', 'probe:24105', 'state:24105']);
});

test('prepareFixedPort: listener 枚举失败属于端口门禁硬失败，不调用 launch', async () => {
  const calls: string[] = [];
  const d: FixedPortDependencies = {
    probe: async () => ({ ready: false }),
    portState: async () => ({ state: 'busy' }),
    listenerPids: async () => {
      throw new Error('lsof ENOENT fixture');
    },
    killPid: () => undefined,
    launch: async port => {
      calls.push(`launch:${port}`);
    },
    sleep: async () => undefined,
  };
  await assert.rejects(
    () => prepareFixedPort(24115, d),
    (error: unknown) => {
      assert.ok(error instanceof FixedPortError);
      assert.match(error.message, /lsof ENOENT fixture/);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('prepareFixedPort: listener 在枚举期间自行退出且端口已空闲，同端口启动而非假报无归属', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }],
    states: [{ state: 'busy' }, { state: 'free' }],
    listeners: [[]],
  });
  assert.deepEqual(await prepareFixedPort(24114, d), { action: 'launch', port: 24114 });
  assert.deepEqual(d.calls, ['probe:24114', 'state:24114', 'listeners:24114', 'probe:24114', 'state:24114']);
});

test('prepareFixedPort: 忙 listener 自行退出后启动前再检查；并发健康 CDP 优先复用', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }, { ready: true, browser: 'Chrome/listener-exit-race' }],
    states: [{ state: 'busy' }, { state: 'free' }],
    listeners: [[951]],
  });
  d.launch = async port => {
    d.calls.push(`launch:${port}`);
  };
  assert.deepEqual(await prepareFixedPort(24117, d), { action: 'reuse', browser: 'Chrome/listener-exit-race' });
  assert.ok(!d.calls.some(call => call.startsWith('launch:')));
});

test('prepareFixedPort: kill 释放端口后启动前再检查；并发健康 CDP 优先复用', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }, { ready: false }, { ready: true, browser: 'Chrome/post-kill-race' }],
    states: [{ state: 'busy' }, { state: 'busy' }, { state: 'free' }],
    listeners: [[961], [961], [961]],
  });
  d.launch = async port => {
    d.calls.push(`launch:${port}`);
  };
  assert.deepEqual(await prepareFixedPort(24118, d), { action: 'reuse', browser: 'Chrome/post-kill-race' });
  assert.deepEqual(
    d.calls.filter(call => call.startsWith('kill:')),
    ['kill:961'],
  );
  assert.ok(!d.calls.some(call => call.startsWith('launch:')));
});

test('prepareFixedPort: 端点状态无法判断时明确失败', async () => {
  const d = dependencies({ probes: [{ ready: false }], states: [{ state: 'unknown', reason: 'EACCES fixture' }] });
  await assert.rejects(() => prepareFixedPort(24106, d), /端口 24106.*状态/);
  assert.deepEqual(d.calls, ['probe:24106', 'state:24106']);
});

test('prepareFixedPort: 任一 kill 抛错则保留真因并停止', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }],
    states: [{ state: 'busy' }, { state: 'busy' }],
    listeners: [
      [701, 702],
      [701, 702],
      [701, 702],
    ],
    killError: new Error('EPERM fixture'),
  });
  await assert.rejects(() => prepareFixedPort(24107, d), /EPERM fixture/);
  assert.deepEqual(d.calls.slice(0, 15), [
    'probe:24107',
    'state:24107',
    'listeners:24107',
    'probe:24107',
    'state:24107',
    'listeners:24107',
    'probe:24107',
    'listeners:24107',
    'listeners:24107',
    'listeners:24107',
    'kill:701',
    'listeners:24107',
    'listeners:24107',
    'kill:702',
    'state:24107',
  ]);
  assert.equal(d.calls.filter(call => call === 'kill:701').length, 1);
  assert.equal(d.calls.filter(call => call === 'kill:702').length, 1);
});

test('prepareFixedPort: 某个 kill 失败仍尝试其余 listener，并复查端口后聚合报错', async () => {
  const calls: string[] = [];
  const d: FixedPortDependencies = {
    probe: async () => ({ ready: false }),
    portState: async () => ({ state: 'busy' }),
    listenerPids: async () => [711, 712],
    killPid: pid => {
      calls.push(`kill:${pid}`);
      if (pid === 711) throw new Error('EPERM 711');
    },
    sleep: async () => undefined,
    releaseTimeoutMs: 0,
    releasePollMs: 100,
  };
  await assert.rejects(() => prepareFixedPort(24111, d), /未释放.*711: EPERM 711/s);
  assert.deepEqual(calls, ['kill:711', 'kill:712']);
});

test('reclaimFixedPortListeners: 早期 kill 失败仍尝试全部 PID，并同时报告最终端口状态和失败', async () => {
  const calls: string[] = [];
  const result = await reclaimFixedPortListeners(24122, [721, 722], {
    listenerPids: async () => [721, 722],
    killPid: pid => {
      calls.push(`kill:${pid}`);
      if (pid === 721) throw new Error('EPERM 721');
    },
    portState: async port => {
      calls.push(`state:${port}`);
      return { state: 'free' };
    },
    sleep: async ms => {
      calls.push(`sleep:${ms}`);
    },
    releaseTimeoutMs: 0,
    releasePollMs: 100,
  });
  assert.deepEqual(calls, ['kill:721', 'kill:722', 'state:24122']);
  assert.deepEqual(result, { state: 'free', killFailures: ['721: EPERM 721'] });
});

test('prepareFixedPort: kill 后端口超时未释放则失败，绝不谎报可启动', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }, { ready: false }],
    states: [{ state: 'busy' }, { state: 'busy' }, { state: 'busy' }, { state: 'busy' }, { state: 'busy' }],
    listeners: [[801], [801], [801]],
  });
  await assert.rejects(() => prepareFixedPort(24108, d), /端口 24108.*未释放/);
  assert.deepEqual(d.calls, [
    'probe:24108',
    'state:24108',
    'listeners:24108',
    'probe:24108',
    'state:24108',
    'listeners:24108',
    'probe:24108',
    'listeners:24108',
    'listeners:24108',
    'listeners:24108',
    'kill:801',
    'state:24108',
    'sleep:200',
    'state:24108',
    'sleep:200',
    'state:24108',
    'sleep:200',
    'state:24108',
  ]);
});

test('prepareFixedPort: kill 后状态变 unknown 也失败而非 launch', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }, { ready: false }],
    states: [{ state: 'busy' }, { state: 'busy' }, { state: 'unknown', reason: 'EADDRNOTAVAIL fixture' }],
    listeners: [[901], [901], [901]],
  });
  await assert.rejects(() => prepareFixedPort(24109, d), /端口 24109.*状态/);
  assert.ok(!d.calls.some(call => call.startsWith('sleep:')));
});

test('parseNetstatListeners: 只认 TCP LISTENING、本地精确端口、正确 host，返回全部 PID 并去重', () => {
  const out = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       11',
    '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       22',
    '  TCP    127.0.0.1:9222         127.0.0.1:54000        ESTABLISHED     33',
    '  TCP    127.0.0.1:54000        127.0.0.1:9222         ESTABLISHED     44',
    '  TCP    127.0.0.1:92220        0.0.0.0:0              LISTENING       55',
    '  TCP    [::1]:9222             [::]:0                 LISTENING       66',
    '  TCP    0.0.0.0:9222           0.0.0.0:0              LISTENING       22',
    '  UDP    127.0.0.1:9222         *:*                                    77',
  ].join('\r\n');
  assert.deepEqual(parseNetstatListeners(out, 9222, '127.0.0.1'), [11, 22]);
  assert.deepEqual(parseNetstatListeners(out, 9222, '::1'), [66]);
});

test('parseLsofListeners: p/f/t/n 状态机只取正确地址族的 LISTEN listener，多 PID 去重', () => {
  const out = [
    'p111',
    'f7',
    'tIPv4',
    'n127.0.0.1:9222',
    'p222',
    'f8',
    'tIPv6',
    'n*:9222',
    'p333',
    'f9',
    'tIPv4',
    'n*:9222',
    'p111',
    'f10',
    'tIPv4',
    'n127.0.0.1:9222',
    'p444',
    'f11',
    'tIPv4',
    'n127.0.0.1:92220',
  ].join('\n');
  assert.deepEqual(parseLsofListeners(out, 9222, '127.0.0.1'), [111, 333]);
  assert.deepEqual(parseLsofListeners(out, 9222, '::1'), [222]);
});

test('parseLsofListeners: IPv6 wildcard 双栈 listener 也能归属 IPv4 回环端点', () => {
  const out = ['p555', 'f7', 'tIPv6', 'n*:9222'].join('\n');
  assert.deepEqual(parseLsofListeners(out, 9222, '127.0.0.1'), [555]);
});

test('parseLsofListeners: 新 fd 清空地址族，无法归属的 wildcard 宁可不杀', () => {
  const out = ['p555', 'f7', 'tIPv6', 'n[::1]:9222', 'f8', 'n*:9222'].join('\n');
  assert.deepEqual(parseLsofListeners(out, 9222, '127.0.0.1'), []);
});

test('parseLsofListenersForHosts: DNS 主机解析出的所有数值地址可归属 listener', () => {
  const out = ['p666', 'f7', 'tIPv4', 'n192.0.2.44:9222', 'p667', 'f8', 'tIPv6', 'n[2001:db8::44]:9222'].join('\n');
  assert.deepEqual(parseLsofListenersForHosts(out, 9222, ['192.0.2.44', '2001:db8::44']), [666, 667]);
});

test('parseNetstatListenersForHosts: DNS 多地址 PID 取并集并去重', () => {
  const out = [
    'TCP 192.0.2.44:9222 0.0.0.0:0 LISTENING 668',
    'TCP [2001:db8::44]:9222 [::]:0 LISTENING 669',
    'TCP 192.0.2.44:9222 0.0.0.0:0 LISTENING 668',
  ].join('\r\n');
  assert.deepEqual(parseNetstatListenersForHosts(out, 9222, ['192.0.2.44', '2001:db8::44']), [668, 669]);
});

test('parseLsofListenersForHosts: 全局有 direct 时不混入另一 host 的 IPv6 wildcard fallback', () => {
  const out = ['p670', 'f7', 'tIPv4', 'n192.0.2.44:9222', 'p671', 'f8', 'tIPv6', 'n[::]:9222'].join('\n');
  assert.deepEqual(parseLsofListenersForHosts(out, 9222, ['192.0.2.44', '198.51.100.7']), [670]);
  assert.deepEqual(
    parseLsofListenersForHosts(out.split('\n').slice(4).join('\n'), 9222, ['192.0.2.44', '198.51.100.7']),
    [671],
  );
});

test('parseNetstatListenersForHosts: 全局有 direct 时不混入另一 host 的 IPv6 wildcard fallback', () => {
  const out = ['TCP 192.0.2.44:9222 0.0.0.0:0 LISTENING 672', 'TCP [::]:9222 [::]:0 LISTENING 673'].join('\r\n');
  assert.deepEqual(parseNetstatListenersForHosts(out, 9222, ['192.0.2.44', '198.51.100.7']), [672]);
  assert.deepEqual(
    parseNetstatListenersForHosts(out.split('\r\n').slice(1).join('\r\n'), 9222, ['192.0.2.44', '198.51.100.7']),
    [673],
  );
});

test('parseLsofListeners: IPv6 合法非压缩写法与 lsof 压缩地址按同一端点匹配', () => {
  const out = ['p777', 'f7', 'tIPv6', 'n[::1]:9222'].join('\n');
  assert.deepEqual(parseLsofListeners(out, 9222, '[0:0:0:0:0:0:0:1]'), [777]);
});

test('parseLsofListeners: IPv4-mapped bracketed IPv6 host 与 IPv4 listener 按同一端点归属', () => {
  const out = ['p778', 'f7', 'tIPv4', 'n127.0.0.1:9222'].join('\n');
  assert.deepEqual(parseLsofListeners(out, 9222, '[::ffff:127.0.0.1]'), [778]);
});
