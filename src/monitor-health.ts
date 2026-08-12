/** monitor daemon 的纯身份/健康协议；无副作用，便于隔离测试。 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cdpHome, type CdpEnvironment } from './paths.ts';

export interface DaemonIdentity {
  home: string;
  cdpHost: string;
  cdpPort: string;
}

interface DaemonHealth {
  ok: true;
  identity: DaemonIdentity;
  targets: number;
}

export type DaemonHealthStatus = 'current' | 'legacy' | 'foreign' | 'unreachable';

export interface DaemonPollOptions {
  fetchImpl?: typeof fetch;
  pollAttempts?: number;
  pollIntervalMs?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

export interface EnsureDaemonOptions extends DaemonPollOptions {
  spawnImpl: () => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_POLL_ATTEMPTS = Math.ceil(8000 / DEFAULT_POLL_INTERVAL_MS);

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function daemonIdentity(
  environment: CdpEnvironment = process.env,
  fallbackHome: string = homedir(),
  cdpHost: string,
  cdpPort: string | number,
): DaemonIdentity {
  return {
    home: resolve(cdpHome(environment, fallbackHome)),
    cdpHost,
    cdpPort: String(cdpPort),
  };
}

export function daemonPidFilePath(environment: CdpEnvironment = process.env, fallbackHome: string = homedir()): string {
  return join(resolve(cdpHome(environment, fallbackHome)), 'cdp-listen.pid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDaemonIdentity(value: unknown): value is DaemonIdentity {
  return (
    isRecord(value) &&
    typeof value.home === 'string' &&
    typeof value.cdpHost === 'string' &&
    typeof value.cdpPort === 'string'
  );
}

function isDaemonHealth(value: unknown): value is DaemonHealth {
  return isRecord(value) && value.ok === true && typeof value.targets === 'number' && isDaemonIdentity(value.identity);
}

export function sameDaemonIdentity(actual: DaemonIdentity, expected: DaemonIdentity): boolean {
  return actual.home === expected.home && actual.cdpHost === expected.cdpHost && actual.cdpPort === expected.cdpPort;
}

/**
 * 识别端口上的 daemon 协议版本与身份。只有连接失败才是 unreachable；
 * 可连接但非 2xx/非 JSON/非 daemon health 都当 foreign，避免在仍占用端口时误 spawn。
 */
export async function probeDaemonHealth(
  port: number,
  expected: DaemonIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonHealthStatus> {
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/health`);
  } catch {
    return 'unreachable';
  }
  if (!response.ok) return 'foreign';

  let health: unknown;
  try {
    health = await response.json();
  } catch {
    return 'foreign';
  }
  if (!isRecord(health)) return 'foreign';
  if (!Object.hasOwn(health, 'identity')) {
    return health.ok === true && typeof health.targets === 'number' ? 'legacy' : 'foreign';
  }
  return isDaemonHealth(health) && sameDaemonIdentity(health.identity, expected) ? 'current' : 'foreign';
}

/** 仅在二次确认仍是无 identity 的 legacy health 后请求退出，并等到 health 真正不可达。 */
export async function retireLegacyDaemon(
  port: number,
  expected: DaemonIdentity,
  options: DaemonPollOptions = {},
): Promise<DaemonHealthStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const confirmed = await probeDaemonHealth(port, expected, fetchImpl);
  if (confirmed !== 'legacy') return confirmed;

  try {
    await fetchImpl(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' });
  } catch {
    // legacy daemon 可能在响应完成前已经退出；以后续 health 为准。
  }
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    await sleepImpl(pollIntervalMs);
    const status = await probeDaemonHealth(port, expected, fetchImpl);
    if (status !== 'legacy') return status;
  }
  return 'legacy';
}

/** 纯生命周期编排：fetch/sleep/spawn 均可注入，不需要启停真实 daemon 即可验证升级路径。 */
export async function ensureDaemonReady(
  port: number,
  expected: DaemonIdentity,
  options: EnsureDaemonOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let status = await probeDaemonHealth(port, expected, fetchImpl);
  if (status === 'current') return;
  if (status === 'foreign') throw new Error(`监听端口 ${port} 已被其它 identity 的 daemon 占用`);

  if (status === 'legacy') {
    status = await retireLegacyDaemon(port, expected, {
      fetchImpl,
      pollAttempts,
      pollIntervalMs,
      sleepImpl,
    });
    if (status === 'current') return;
    if (status === 'foreign') throw new Error(`监听端口 ${port} 已被其它 identity 的 daemon 占用`);
    if (status === 'legacy') throw new Error(`旧版监听 daemon 无法在端口 ${port} 退出`);
  }

  await options.spawnImpl();
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    await sleepImpl(pollIntervalMs);
    status = await probeDaemonHealth(port, expected, fetchImpl);
    if (status === 'current') return;
    if (status === 'foreign' || status === 'legacy') {
      throw new Error(`监听 daemon 启动失败:端口 ${port} 已被其它 daemon 占用`);
    }
  }
  throw new Error('监听 daemon 启动失败');
}

/** 只有身份完全一致的 current daemon 才算健康。 */
export async function daemonHealthy(
  port: number,
  expected: DaemonIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return (await probeDaemonHealth(port, expected, fetchImpl)) === 'current';
}
