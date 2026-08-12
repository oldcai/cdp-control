/** monitor daemon 的纯身份/健康协议；无副作用，便于隔离测试。 */
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { cdpHome, type CdpEnvironment } from './paths.ts';
import { MONITOR_SPAWN_READY_WAIT_TIMEOUT_MS } from './monitor-timing.ts';

export interface DaemonIdentity {
  home: string;
  cdpHost: string;
  cdpPort: string;
}

export interface DaemonInstance {
  pid: number;
  birth: string;
}

export type DaemonPhase = 'starting' | 'ready' | 'stopping';

interface LegacyIdentityDaemonHealth {
  ok: true;
  identity: DaemonIdentity;
  targets: number;
}

interface VersionedDaemonHealth {
  service: typeof DAEMON_SERVICE;
  protocol: {
    major: number;
    minor: number;
  };
  identity: DaemonIdentity;
  instance: DaemonInstance;
  health: {
    phase: DaemonPhase;
    targets: number;
  };
}

export interface DaemonHealthPayloads {
  legacy: LegacyIdentityDaemonHealth;
  versioned: VersionedDaemonHealth;
}

export const DAEMON_SERVICE = 'cdp-control.monitor';
export const DAEMON_PROTOCOL_MAJOR = 1;
export const DAEMON_PROTOCOL_MINOR = 0;

export type RetirableDaemonStatus = 'legacy';
export interface IncompatibleDaemonStatus {
  kind: 'incompatible';
  reason: string;
}

export interface TransitionDaemonStatus {
  kind: 'transition';
  phase: Exclude<DaemonPhase, 'ready'>;
  instance: DaemonInstance;
}

export interface CurrentDaemonStatus {
  kind: 'current';
  protocol: 'v1';
  instance: DaemonInstance;
}

export interface OwnedStaleDaemonStatus {
  kind: 'owned-stale';
  protocol: 'v0' | 'v1';
  identity: DaemonIdentity;
  instance?: DaemonInstance;
}

export type DaemonHealthStatus =
  | 'current'
  | RetirableDaemonStatus
  | 'foreign'
  | 'unreachable'
  | CurrentDaemonStatus
  | OwnedStaleDaemonStatus
  | IncompatibleDaemonStatus
  | TransitionDaemonStatus;

export interface DaemonPollOptions {
  fetchImpl?: typeof fetch;
  listenerOccupiedImpl?: (port: number, timeoutMs: number) => Promise<boolean>;
  pollAttempts?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

export interface EnsureDaemonOptions extends DaemonPollOptions {
  retireDaemonImpl: (candidate: RetirableDaemonCandidate) => Promise<void>;
  spawnImpl: () => Promise<void>;
}

export type RetirableDaemonCandidate = RetirableDaemonStatus | OwnedStaleDaemonStatus;

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_POLL_ATTEMPTS = Math.ceil(MONITOR_SPAWN_READY_WAIT_TIMEOUT_MS / DEFAULT_POLL_INTERVAL_MS);
const DEFAULT_REQUEST_TIMEOUT_MS = 2000;

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

export function daemonHealthPayloads(
  identity: DaemonIdentity,
  instance: DaemonInstance,
  phase: DaemonPhase,
  targets: number,
): DaemonHealthPayloads {
  return {
    legacy: { ok: true, identity, targets },
    versioned: {
      service: DAEMON_SERVICE,
      protocol: { major: DAEMON_PROTOCOL_MAJOR, minor: DAEMON_PROTOCOL_MINOR },
      identity,
      instance,
      health: { phase, targets },
    },
  };
}

export function daemonPidFilePath(environment: CdpEnvironment = process.env, fallbackHome: string = homedir()): string {
  return join(resolve(cdpHome(environment, fallbackHome)), 'cdp-listen.pid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isVersionedDaemonIdentity(value: unknown): value is DaemonIdentity {
  return (
    isRecord(value) &&
    typeof value.home === 'string' &&
    value.home.length > 0 &&
    isAbsolute(value.home) &&
    resolve(value.home) === value.home &&
    typeof value.cdpHost === 'string' &&
    value.cdpHost.length > 0 &&
    typeof value.cdpPort === 'string' &&
    value.cdpPort.length > 0
  );
}

function isLegacyDaemonIdentity(value: unknown): value is DaemonIdentity {
  return isRecord(value) && hasExactKeys(value, ['home', 'cdpHost', 'cdpPort']) && isVersionedDaemonIdentity(value);
}

function isLegacyIdentityDaemonHealth(value: unknown): value is LegacyIdentityDaemonHealth {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['ok', 'identity', 'targets']) &&
    value.ok === true &&
    isNonNegativeInteger(value.targets) &&
    isLegacyDaemonIdentity(value.identity)
  );
}

function incompatible(reason: string): IncompatibleDaemonStatus {
  return { kind: 'incompatible', reason };
}

type VersionedParseResult =
  | { result: 'unrecognized' }
  | { result: 'incompatible'; status: IncompatibleDaemonStatus }
  | { result: 'valid'; health: VersionedDaemonHealth };

function incompatibleParse(reason: string): VersionedParseResult {
  return { result: 'incompatible', status: incompatible(reason) };
}

function parseVersionedDaemonHealth(value: unknown): VersionedParseResult {
  if (!isRecord(value) || value.service !== DAEMON_SERVICE) return { result: 'unrecognized' };
  if (!isRecord(value.protocol)) return incompatibleParse('protocol 缺失或格式无效');
  if (!Number.isSafeInteger(value.protocol.major) || !Number.isSafeInteger(value.protocol.minor)) {
    return incompatibleParse('protocol major/minor 必须是整数');
  }
  if (value.protocol.major !== DAEMON_PROTOCOL_MAJOR) {
    return incompatibleParse(`不支持 daemon protocol major ${String(value.protocol.major)}`);
  }
  if ((value.protocol.minor as number) < 0) return incompatibleParse('protocol minor 必须是非负整数');
  if (!isVersionedDaemonIdentity(value.identity)) return incompatibleParse('identity 缺失或格式无效');
  if (
    !isRecord(value.instance) ||
    !Number.isSafeInteger(value.instance.pid) ||
    (value.instance.pid as number) <= 0 ||
    typeof value.instance.birth !== 'string' ||
    value.instance.birth.trim().length === 0
  ) {
    return incompatibleParse('instance 缺失或格式无效');
  }
  if (
    !isRecord(value.health) ||
    (value.health.phase !== 'starting' && value.health.phase !== 'ready' && value.health.phase !== 'stopping') ||
    !isNonNegativeInteger(value.health.targets)
  ) {
    return incompatibleParse('health 缺失或格式无效');
  }
  return { result: 'valid', health: value as unknown as VersionedDaemonHealth };
}

function isLegacyDaemonHealth(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['ok', 'targets']) && value.ok === true && isNonNegativeInteger(value.targets);
}

export function sameDaemonIdentity(actual: DaemonIdentity, expected: DaemonIdentity): boolean {
  return actual.home === expected.home && actual.cdpHost === expected.cdpHost && actual.cdpPort === expected.cdpPort;
}

function classifyDaemonIdentity(actual: DaemonIdentity, expected: DaemonIdentity): 'same' | 'owned-stale' | 'foreign' {
  if (sameDaemonIdentity(actual, expected)) return 'same';
  return actual.home === expected.home ? 'owned-stale' : 'foreign';
}

interface HealthResponse {
  body: unknown | undefined;
  ok: boolean;
  status: number;
}

class HealthRequestTimeout extends Error {
  readonly connected: boolean;

  constructor(connected: boolean, timeoutMs: number) {
    super(`health request timed out after ${timeoutMs}ms`);
    this.name = 'HealthRequestTimeout';
    this.connected = connected;
  }
}

async function healthRequest(
  port: number,
  path: '/health/v1' | '/health',
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<HealthResponse> {
  const controller = new AbortController();
  let connected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const cause = new HealthRequestTimeout(connected, timeoutMs);
      controller.abort(cause);
      reject(cause);
    }, timeoutMs);
  });
  const request = Promise.resolve().then(async () => {
    const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
      redirect: 'manual',
      signal: controller.signal,
    });
    connected = true;
    if (!response.ok) return { body: undefined, ok: false, status: response.status };
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      if (controller.signal.aborted) throw cause;
      body = undefined;
    }
    return { body, ok: true, status: response.status };
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function loopbackListenerOccupied(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveOccupied, rejectUnknown) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (result: { occupied: boolean } | { cause: Error }): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if ('cause' in result) rejectUnknown(result.cause);
      else resolveOccupied(result.occupied);
    };
    socket.setTimeout(timeoutMs, () =>
      finish({ cause: new Error(`TCP occupancy probe timed out after ${timeoutMs}ms`) }),
    );
    socket.once('connect', () => finish({ occupied: true }));
    socket.once('error', cause => {
      const code = (cause as NodeJS.ErrnoException).code;
      finish(code === 'ECONNREFUSED' ? { occupied: false } : { cause });
    });
  });
}

async function classifyRequestFailure(
  cause: unknown,
  port: number,
  timeoutMs: number,
  listenerOccupiedImpl: (port: number, timeoutMs: number) => Promise<boolean>,
): Promise<'foreign' | 'unreachable'> {
  if (cause instanceof HealthRequestTimeout && cause.connected) return 'foreign';
  try {
    if (await listenerOccupiedImpl(port, timeoutMs)) return 'foreign';
  } catch {
    return 'foreign';
  }
  return 'unreachable';
}

function classifyVersionedHealth(health: VersionedDaemonHealth, expected: DaemonIdentity): DaemonHealthStatus {
  const ownership = classifyDaemonIdentity(health.identity, expected);
  if (ownership === 'foreign') return 'foreign';
  if (health.health.phase !== 'ready') {
    return { kind: 'transition', phase: health.health.phase, instance: health.instance };
  }
  return ownership === 'same'
    ? { kind: 'current', protocol: 'v1', instance: health.instance }
    : { identity: health.identity, kind: 'owned-stale', protocol: 'v1', instance: health.instance };
}

function classifyLegacyHealth(health: unknown, expected: DaemonIdentity): DaemonHealthStatus {
  if (!isRecord(health)) return 'foreign';
  if (!Object.hasOwn(health, 'identity')) return isLegacyDaemonHealth(health) ? 'legacy' : 'foreign';
  if (!isLegacyIdentityDaemonHealth(health)) return 'foreign';
  const ownership = classifyDaemonIdentity(health.identity, expected);
  return ownership === 'same'
    ? 'current'
    : ownership === 'owned-stale'
      ? { identity: health.identity, kind: 'owned-stale', protocol: 'v0' }
      : 'foreign';
}

/**
 * 识别端口上的 daemon 协议版本与身份。只有独立 TCP probe 明确得到 ECONNREFUSED 才是 unreachable；
 * 可连接但非 2xx/非 JSON/非 daemon health 都当 foreign，避免在仍占用端口时误 spawn。
 */
export async function probeDaemonHealth(
  port: number,
  expected: DaemonIdentity,
  fetchImpl: typeof fetch = fetch,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  listenerOccupiedImpl: (port: number, timeoutMs: number) => Promise<boolean> = loopbackListenerOccupied,
): Promise<DaemonHealthStatus> {
  let response: HealthResponse;
  try {
    response = await healthRequest(port, '/health/v1', fetchImpl, requestTimeoutMs);
  } catch (cause) {
    return classifyRequestFailure(cause, port, requestTimeoutMs, listenerOccupiedImpl);
  }
  if (response.status !== 404) {
    if (!response.ok) return 'foreign';
    const health = response.body;
    if (health === undefined) return 'foreign';
    const parsed = parseVersionedDaemonHealth(health);
    if (parsed.result === 'unrecognized') return 'foreign';
    if (parsed.result === 'incompatible') return parsed.status;
    return classifyVersionedHealth(parsed.health, expected);
  }

  try {
    response = await healthRequest(port, '/health', fetchImpl, requestTimeoutMs);
  } catch (cause) {
    return classifyRequestFailure(cause, port, requestTimeoutMs, listenerOccupiedImpl);
  }
  if (!response.ok) return 'foreign';
  return classifyLegacyHealth(response.body, expected);
}

function isCurrentStatus(status: DaemonHealthStatus): status is 'current' | CurrentDaemonStatus {
  return status === 'current' || (typeof status === 'object' && status.kind === 'current');
}

function isTransitionStatus(status: DaemonHealthStatus): status is TransitionDaemonStatus {
  return typeof status === 'object' && status.kind === 'transition';
}

function isIncompatibleStatus(status: DaemonHealthStatus): status is IncompatibleDaemonStatus {
  return typeof status === 'object' && status.kind === 'incompatible';
}

function isRetirableCandidate(status: DaemonHealthStatus): status is RetirableDaemonCandidate {
  return status === 'legacy' || (typeof status === 'object' && status.kind === 'owned-stale');
}

function sameDaemonInstance(left: DaemonInstance, right: DaemonInstance): boolean {
  return left.pid === right.pid && left.birth === right.birth;
}

function sameRetirableCandidate(left: RetirableDaemonCandidate, right: DaemonHealthStatus): boolean {
  if (typeof left === 'string') return left === right;
  return (
    typeof right === 'object' &&
    right.kind === 'owned-stale' &&
    sameDaemonIdentity(left.identity, right.identity) &&
    left.protocol === right.protocol &&
    (left.protocol === 'v0' ||
      (right.instance !== undefined &&
        left.instance !== undefined &&
        sameDaemonInstance(left.instance, right.instance)))
  );
}

function incompatibleError(port: number, status: IncompatibleDaemonStatus): Error {
  return new Error(`监听端口 ${port} 上的 cdp-control daemon 协议不兼容: ${status.reason}`);
}

function foreignError(port: number): Error {
  return new Error(`监听端口 ${port} 已被其它 identity 或 service 占用`);
}

async function waitForTransition(
  port: number,
  expected: DaemonIdentity,
  initial: TransitionDaemonStatus,
  options: Required<
    Pick<
      DaemonPollOptions,
      'fetchImpl' | 'listenerOccupiedImpl' | 'pollAttempts' | 'pollIntervalMs' | 'requestTimeoutMs' | 'sleepImpl'
    >
  >,
): Promise<DaemonHealthStatus> {
  let status: DaemonHealthStatus = initial;
  for (let attempt = 0; attempt < options.pollAttempts; attempt++) {
    await options.sleepImpl(options.pollIntervalMs);
    status = await probeDaemonHealth(
      port,
      expected,
      options.fetchImpl,
      options.requestTimeoutMs,
      options.listenerOccupiedImpl,
    );
    if (!isTransitionStatus(status)) return status;
  }
  return status;
}

/** 仅在二次确认同一候选后退出已验证进程，并等 health 改变。 */
async function retireOwnedDaemon(
  port: number,
  expected: DaemonIdentity,
  candidate: RetirableDaemonCandidate,
  options: DaemonPollOptions & { retireDaemonImpl: (candidate: RetirableDaemonCandidate) => Promise<void> },
): Promise<DaemonHealthStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const listenerOccupiedImpl = options.listenerOccupiedImpl ?? loopbackListenerOccupied;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const confirmed = await probeDaemonHealth(port, expected, fetchImpl, requestTimeoutMs, listenerOccupiedImpl);
  if (!sameRetirableCandidate(candidate, confirmed)) return confirmed;

  await options.retireDaemonImpl(candidate);
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    await sleepImpl(pollIntervalMs);
    const status = await probeDaemonHealth(port, expected, fetchImpl, requestTimeoutMs, listenerOccupiedImpl);
    if (!sameRetirableCandidate(candidate, status)) return status;
  }
  return candidate;
}

/** 纯生命周期编排：fetch/sleep/spawn 均可注入，不需要启停真实 daemon 即可验证升级路径。 */
export async function ensureDaemonReady(
  port: number,
  expected: DaemonIdentity,
  options: EnsureDaemonOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const listenerOccupiedImpl = options.listenerOccupiedImpl ?? loopbackListenerOccupied;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let status = await probeDaemonHealth(port, expected, fetchImpl, requestTimeoutMs, listenerOccupiedImpl);
  if (isCurrentStatus(status)) return;
  if (status === 'foreign') throw foreignError(port);
  if (isIncompatibleStatus(status)) throw incompatibleError(port, status);

  if (isTransitionStatus(status)) {
    status = await waitForTransition(port, expected, status, {
      fetchImpl,
      listenerOccupiedImpl,
      pollAttempts,
      pollIntervalMs,
      requestTimeoutMs,
      sleepImpl,
    });
    if (isCurrentStatus(status)) return;
    if (status === 'foreign') throw foreignError(port);
    if (isIncompatibleStatus(status)) throw incompatibleError(port, status);
    if (isTransitionStatus(status))
      throw new Error(`监听端口 ${port} 上的 daemon 一直处于 ${status.phase}，未进入 ready`);
  }

  if (isRetirableCandidate(status)) {
    const retiring = status;
    status = await retireOwnedDaemon(port, expected, retiring, {
      fetchImpl,
      listenerOccupiedImpl,
      pollAttempts,
      pollIntervalMs,
      requestTimeoutMs,
      retireDaemonImpl: options.retireDaemonImpl,
      sleepImpl,
    });
    if (isCurrentStatus(status)) return;
    if (status === 'foreign') throw foreignError(port);
    if (isIncompatibleStatus(status)) throw incompatibleError(port, status);
    if (isTransitionStatus(status)) {
      status = await waitForTransition(port, expected, status, {
        fetchImpl,
        listenerOccupiedImpl,
        pollAttempts,
        pollIntervalMs,
        requestTimeoutMs,
        sleepImpl,
      });
      if (isCurrentStatus(status)) return;
      if (status === 'foreign') throw foreignError(port);
      if (isIncompatibleStatus(status)) throw incompatibleError(port, status);
      if (isTransitionStatus(status)) {
        throw new Error(`监听端口 ${port} 上的 daemon 接管后一直处于 ${status.phase}，未进入 ready`);
      }
    }
    if (isRetirableCandidate(status)) {
      throw new Error(`已拥有的监听 daemon 无法在端口 ${port} 退出`);
    }
  }

  // unreachable 可能只是并发 ensure 尚未完成；spawn 前必须重新建立端口事实。
  if (status === 'unreachable') {
    status = await probeDaemonHealth(port, expected, fetchImpl, requestTimeoutMs, listenerOccupiedImpl);
    if (isCurrentStatus(status)) return;
    if (status === 'foreign') throw foreignError(port);
    if (isIncompatibleStatus(status)) throw incompatibleError(port, status);
    if (isTransitionStatus(status)) {
      status = await waitForTransition(port, expected, status, {
        fetchImpl,
        listenerOccupiedImpl,
        pollAttempts,
        pollIntervalMs,
        requestTimeoutMs,
        sleepImpl,
      });
      if (isCurrentStatus(status)) return;
      if (status === 'foreign') throw foreignError(port);
      if (isIncompatibleStatus(status)) throw incompatibleError(port, status);
      if (isTransitionStatus(status)) {
        throw new Error(`监听端口 ${port} 上的并发 daemon 一直处于 ${status.phase}，未进入 ready`);
      }
    }
    if (isRetirableCandidate(status)) {
      throw new Error(`监听端口 ${port} 在启动前出现待接管 daemon，拒绝覆盖`);
    }
  }

  await options.spawnImpl();
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    await sleepImpl(pollIntervalMs);
    status = await probeDaemonHealth(port, expected, fetchImpl, requestTimeoutMs, listenerOccupiedImpl);
    if (isCurrentStatus(status)) return;
    if (status === 'foreign' || isRetirableCandidate(status)) {
      throw new Error(`监听 daemon 启动失败:端口 ${port} 已被其它 daemon 占用`);
    }
    if (isIncompatibleStatus(status)) throw incompatibleError(port, status);
  }
  if (isTransitionStatus(status)) throw new Error(`监听 daemon 启动后一直处于 ${status.phase}，未进入 ready`);
  throw new Error('监听 daemon 启动失败:health 一直不可达');
}

/** 只有身份完全一致的 current daemon 才算健康。 */
export async function daemonHealthy(
  port: number,
  expected: DaemonIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return isCurrentStatus(await probeDaemonHealth(port, expected, fetchImpl));
}
