/**
 * browser-port.test.ts — 固定配置端口的监听解析与回收编排单测。
 * 编排依赖全部注入：不碰真实进程，不杀真实端口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareFixedPort,
  parseNetstatListeners,
  parseLsofListeners,
  type FixedPortDependencies,
  type ProbeResult,
  type PortState,
  FixedPortError,
  hasCdpWebSocket,
  lsofListenerArgs,
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

function dependencies(options: {
  probes?: ProbeResult[];
  busyGraceProbes?: ProbeResult[];
  states?: PortState[];
  listeners?: number[][];
  killError?: Error;
} = {}): FixedPortDependencies & { calls: string[] } {
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
    ...(busyGraceProbes ? {
      busyGraceProbe: async (port: number) => {
        calls.push(`grace:${port}`);
        return busyGraceProbes.shift() ?? { ready: false };
      },
    } : {}),
    portState: async port => {
      calls.push(`state:${port}`);
      if (states.length > 1) return states.shift()!;
      return states[0] ?? { state: 'free' };
    },
    listenerPids: async port => {
      calls.push(`listeners:${port}`);
      return listeners.shift() ?? [];
    },
    killPid: pid => {
      calls.push(`kill:${pid}`);
      if (options.killError) throw options.killError;
    },
    sleep: async ms => { calls.push(`sleep:${ms}`); },
    releaseTimeoutMs: 600,
    releasePollMs: 200,
  };
}

test('prepareFixedPort: 健康 CDP 直接复用，不查监听、不 kill', async () => {
  const d = dependencies({ probes: [{ ready: true, browser: 'Chrome/1' }] });
  assert.deepEqual(await prepareFixedPort(24101, d), { action: 'reuse', browser: 'Chrome/1' });
  assert.deepEqual(d.calls, ['probe:24101']);
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

test('prepareFixedPort: 注入 launch 时启动前再检查；并发变健康就复用且不 spawn', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: true, browser: 'Chrome/free-race' }],
    states: [{ state: 'free' }],
  });
  d.launch = async port => { d.calls.push(`launch:${port}`); };
  assert.deepEqual(await prepareFixedPort(24112, d), { action: 'reuse', browser: 'Chrome/free-race' });
  assert.deepEqual(d.calls, ['probe:24112', 'state:24112', 'probe:24112']);
});

test('prepareFixedPort: 注入 launch 时两次确认空闲才在原配置端口 spawn', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }, { ready: false }],
    states: [{ state: 'free' }, { state: 'free' }],
  });
  d.launch = async port => { d.calls.push(`launch:${port}`); };
  assert.deepEqual(await prepareFixedPort(24113, d), { action: 'launch', port: 24113 });
  assert.deepEqual(d.calls, ['probe:24113', 'state:24113', 'probe:24113', 'state:24113', 'launch:24113']);
});

test('prepareFixedPort: 忙且非健康时 kill 全部去重 listener，确认释放后仍启动配置端口', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }],
    busyGraceProbes: [{ ready: false }],
    states: [{ state: 'busy' }, { state: 'busy' }, { state: 'free' }],
    listeners: [[501, 502, 501], [501, 502], [502, 501]],
  });
  assert.deepEqual(await prepareFixedPort(24103, d), { action: 'launch', port: 24103 });
  assert.deepEqual(d.calls, [
    'probe:24103', 'state:24103', 'grace:24103', 'listeners:24103', 'probe:24103', 'state:24103', 'listeners:24103',
    'probe:24103', 'listeners:24103', 'kill:502', 'kill:501', 'state:24103',
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
    'probe:24110', 'state:24110', 'listeners:24110', 'probe:24110', 'state:24110', 'listeners:24110',
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
    killPid: pid => { calls.push(`kill:${pid}`); },
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
    listenerPids: async () => { throw new Error('lsof ENOENT fixture'); },
    killPid: () => undefined,
    launch: async port => { calls.push(`launch:${port}`); },
    sleep: async () => undefined,
  };
  await assert.rejects(() => prepareFixedPort(24115, d), (error: unknown) => {
    assert.ok(error instanceof FixedPortError);
    assert.match(error.message, /lsof ENOENT fixture/);
    return true;
  });
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
  d.launch = async port => { d.calls.push(`launch:${port}`); };
  assert.deepEqual(await prepareFixedPort(24117, d), { action: 'reuse', browser: 'Chrome/listener-exit-race' });
  assert.ok(!d.calls.some(call => call.startsWith('launch:')));
});

test('prepareFixedPort: kill 释放端口后启动前再检查；并发健康 CDP 优先复用', async () => {
  const d = dependencies({
    probes: [
      { ready: false },
      { ready: false },
      { ready: false },
      { ready: true, browser: 'Chrome/post-kill-race' },
    ],
    states: [{ state: 'busy' }, { state: 'busy' }, { state: 'free' }],
    listeners: [[961], [961], [961]],
  });
  d.launch = async port => { d.calls.push(`launch:${port}`); };
  assert.deepEqual(await prepareFixedPort(24118, d), { action: 'reuse', browser: 'Chrome/post-kill-race' });
  assert.deepEqual(d.calls.filter(call => call.startsWith('kill:')), ['kill:961']);
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
    listeners: [[701, 702], [701, 702], [701, 702]],
    killError: new Error('EPERM fixture'),
  });
  await assert.rejects(() => prepareFixedPort(24107, d), /EPERM fixture/);
  assert.deepEqual(d.calls.slice(0, 11), [
    'probe:24107', 'state:24107', 'listeners:24107', 'probe:24107', 'state:24107',
    'listeners:24107', 'probe:24107', 'listeners:24107', 'kill:701', 'kill:702', 'state:24107',
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
    killPid: pid => { calls.push(`kill:${pid}`); if (pid === 711) throw new Error('EPERM 711'); },
    sleep: async () => undefined,
    releaseTimeoutMs: 0,
    releasePollMs: 100,
  };
  await assert.rejects(() => prepareFixedPort(24111, d), /未释放.*711: EPERM 711/s);
  assert.deepEqual(calls, ['kill:711', 'kill:712']);
});

test('prepareFixedPort: kill 后端口超时未释放则失败，绝不谎报可启动', async () => {
  const d = dependencies({
    probes: [{ ready: false }, { ready: false }, { ready: false }],
    states: [{ state: 'busy' }, { state: 'busy' }, { state: 'busy' }, { state: 'busy' }, { state: 'busy' }],
    listeners: [[801], [801], [801]],
  });
  await assert.rejects(() => prepareFixedPort(24108, d), /端口 24108.*未释放/);
  assert.deepEqual(d.calls, [
    'probe:24108', 'state:24108', 'listeners:24108', 'probe:24108', 'state:24108', 'listeners:24108',
    'probe:24108', 'listeners:24108', 'kill:801',
    'state:24108', 'sleep:200', 'state:24108', 'sleep:200', 'state:24108', 'sleep:200', 'state:24108',
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
    'p111', 'f7', 'tIPv4', 'n127.0.0.1:9222',
    'p222', 'f8', 'tIPv6', 'n*:9222',
    'p333', 'f9', 'tIPv4', 'n*:9222',
    'p111', 'f10', 'tIPv4', 'n127.0.0.1:9222',
    'p444', 'f11', 'tIPv4', 'n127.0.0.1:92220',
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
