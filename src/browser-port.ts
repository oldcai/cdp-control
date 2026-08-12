/**
 * browser-port.ts — 固定 CDP 端口的状态判断、监听者解析与安全回收编排。
 * 网络/进程副作用由 browser.ts 注入；核心状态机可纯单测。
 */
import { isIP } from 'node:net';

export interface ProbeResult {
  ready: boolean;
  browser?: string;
  /** 需要 pin 的已解析数值地址；多地址 hostname 成功探活后也必须带回。 */
  address?: string;
}
export type PortState = { state: 'free' } | { state: 'busy' } | { state: 'unknown'; reason: string };
export type AddressPortState =
  | { address: string; state: 'free' }
  | { address: string; state: 'busy' }
  | { address: string; state: 'unknown'; code: string; reason: string };
export type FixedPortAction = { action: 'reuse'; browser?: string } | { action: 'launch'; port: number };

/** 端口门禁失败；调用方据此区分“不得继续”的安全错误与某个浏览器候选自身启动失败。 */
export class FixedPortError extends Error {}

/** 只记录并清理由本轮固定端口流程实际 spawn 的句柄，避免误杀进程内历史浏览器。 */
export class FixedPortLaunchAttempt<Process> {
  /** 当前仍由本轮负责终止的进程；退出后立即释放该归属。 */
  launched: Process | null = null;

  /** 记录终止所有权，并返回不受后续 release 影响的本轮精确句柄。 */
  record(process: Process): Process {
    this.launched = process;
    return process;
  }

  release(process: Process): void {
    if (this.launched === process) this.launched = null;
  }

  cleanup(terminate: (process: Process) => void): void {
    const launched = this.launched;
    this.launched = null;
    if (launched !== null) terminate(launched);
  }
}

/** `/json/version` 只有给出真正的 ws/wss 调试地址才算健康 CDP。 */
export function hasCdpWebSocket(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const websocket = (value as Record<string, unknown>).webSocketDebuggerUrl;
  if (typeof websocket !== 'string' || !websocket.trim()) return false;
  try {
    const protocol = new URL(websocket).protocol;
    return protocol === 'ws:' || protocol === 'wss:';
  } catch {
    return false;
  }
}

export function lsofListenerArgs(port: number): string[] {
  return ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpnt'];
}

/** HTTP URL 中 IPv6 需要括号，Node socket API 则必须使用裸地址。 */
export function socketHost(host: string): string {
  return host.trim().replace(/^\[([^\]]+)\]$/, '$1');
}

export interface LookupAddress {
  address: string;
}

export type LookupAll = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

/** 数值 host 直接使用；localhost 显式覆盖双回环；DNS 主机必须保留 all:true 的全部地址。 */
export async function resolveSocketHosts(host: string, lookupAll: LookupAll): Promise<string[]> {
  const normalized = socketHost(host).toLowerCase();
  if (normalized === 'localhost') return ['127.0.0.1', '::1'];
  if (isIP(normalized)) return [canonicalAddress(normalized)];
  const addresses = await lookupAll(normalized, { all: true });
  const hosts = [...new Set(addresses.map(entry => canonicalAddress(entry.address)))];
  if (!hosts.length) throw new Error('DNS 未返回地址');
  return hosts;
}

export interface HostCdpProbeDependencies {
  /** 原始 CDP_HOST；只有它本身是数值地址时才允许跳过二次探活。 */
  originalHost?: string;
  primary(): Promise<ProbeResult>;
  resolveAddresses(): Promise<string[]>;
  address(host: string): Promise<ProbeResult>;
}

/**
 * 主 hostname 连接未就绪时检查全部解析地址。多地址 hostname 即使主请求成功，
 * 也必须把健康 CDP 归属到具体数值地址再 pin，避免后续请求/daemon 重新解析到非 CDP 端点。
 * 单一数值 host 保留一 GET 快路径。
 */
export async function probeHostCdp(deps: HostCdpProbeDependencies): Promise<ProbeResult> {
  let primary: ProbeResult = { ready: false };
  try {
    primary = await deps.primary();
  } catch {}

  let addresses: string[];
  try {
    addresses = await deps.resolveAddresses();
  } catch (cause) {
    if (cause instanceof FixedPortError) throw cause;
    if (primary.ready) {
      throw new FixedPortError('无法解析 CDP_HOST 的全部地址，拒绝在未归属的健康端点上继续', { cause });
    }
    // portState 会将同一解析失败归类为 unknown，由固定端口门禁报真因。
    return { ready: false };
  }

  if (primary.ready && addresses.length <= 1 && isIP(socketHost(deps.originalHost ?? '')) !== 0) {
    return addresses[0] ? { ...primary, address: addresses[0] } : primary;
  }

  const resolved = await Promise.all(
    addresses.map(async address => {
      try {
        return { address, probe: await deps.address(address) };
      } catch {
        return { address, probe: { ready: false } satisfies ProbeResult };
      }
    }),
  );
  const healthy = resolved.find(result => result.probe.ready);
  if (healthy) return { ...healthy.probe, address: healthy.address };
  if (primary.ready) {
    throw new FixedPortError(
      `hostname 探活成功，但未能把健康 CDP 归属到任一解析地址(${addresses.join(', ')})，拒绝继续`,
    );
  }
  return { ready: false };
}

const FAMILY_OFF = new Set(['EAFNOSUPPORT', 'EPFNOSUPPORT', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'EINVAL']);

/** 多地址 host 的探测结论：非可忽略 unknown 优先于 busy；仅跳过本机不可用的回环地址族。 */
export function combineAddressStates(states: AddressPortState[]): PortState {
  const unknown = states.filter(
    (state): state is Extract<AddressPortState, { state: 'unknown' }> =>
      state.state === 'unknown' && !loopbackFamilyUnavailable(state.address, state.code),
  );
  if (unknown.length) return { state: 'unknown', reason: unknown.map(state => state.reason).join('; ') };
  if (states.some(state => state.state === 'busy')) return { state: 'busy' };
  if (states.some(state => state.state === 'free')) return { state: 'free' };
  return { state: 'unknown', reason: '没有可用的本机地址族' };
}

function loopbackFamilyUnavailable(address: string, code: string): boolean {
  const normalized = canonicalAddress(address);
  const loopback = normalized === '::1' || normalized === '::ffff:127.0.0.1' || /^127\./.test(normalized);
  return loopback && FAMILY_OFF.has(code);
}

export interface PortAddressDependencies {
  connect(port: number, address: string): Promise<AddressPortState>;
  bind(port: number, address: string): Promise<AddressPortState>;
}

/** 逐地址 connect，全部可用时再逐地址 exclusive bind，避免 localhost/DNS 只检查首地址。 */
export async function probePortAddresses(
  port: number,
  addresses: string[],
  deps: PortAddressDependencies,
): Promise<PortState> {
  const connected = combineAddressStates(await Promise.all(addresses.map(address => deps.connect(port, address))));
  if (connected.state !== 'free') return connected;
  return combineAddressStates(await Promise.all(addresses.map(address => deps.bind(port, address))));
}

export interface CdpReadyWaitDependencies {
  probe(timeoutMs: number): Promise<boolean>;
  exitReason(): string | null;
  sleep(ms: number): Promise<void>;
  now(): number;
  assertAuthority?(): void;
  /** 成功分类前确认本轮地址身份仍有效；抛错即不得把其它端点误报为本轮 launch。 */
  assertEndpoint?(): void | Promise<void>;
}

/**
 * 等待固定端口上的 CDP 就绪。子进程早退后仍给并发启动者一段有界复探窗口；窗口结束
 * 仍未就绪才抛原始退出原因，避免 Chrome 单例竞态被误报为启动失败。
 */
export async function waitForCdpReady(
  deps: CdpReadyWaitDependencies,
  timeoutMs = 20_000,
  earlyExitGraceMs = 3_000,
  pollMs = 400,
): Promise<void> {
  const overallDeadline = deps.now() + timeoutMs;
  let exitDeadline: number | null = null;
  let rememberedExit: string | null = null;

  while (true) {
    deps.assertAuthority?.();
    const now = deps.now();
    const exit = deps.exitReason();
    if (exit && exitDeadline === null) {
      rememberedExit = exit;
      exitDeadline = Math.min(overallDeadline, now + earlyExitGraceMs);
    }
    const activeDeadline = exitDeadline ?? overallDeadline;
    const remaining = activeDeadline - now;
    if (remaining <= 0) break;

    let ready = false;
    try {
      ready = await deps.probe(Math.min(1_000, remaining));
    } catch (cause) {
      if (cause instanceof FixedPortError) throw cause;
    }
    deps.assertAuthority?.();
    await deps.assertEndpoint?.();
    // exact child 已退出时，端点变健康只能属于并发调用者。抛出早退真因，
    // 交给 settleFixedPortLaunch 重进门禁并正确分类为 reuse，不得谎报本轮 launch 成功。
    if (ready) {
      const exited = deps.exitReason() ?? rememberedExit;
      if (exited) throw new Error(exited);
      return;
    }

    const exitAfterProbe = deps.exitReason();
    if (exitAfterProbe && exitDeadline === null) {
      rememberedExit = exitAfterProbe;
      exitDeadline = Math.min(overallDeadline, deps.now() + earlyExitGraceMs);
    }
    const nextDeadline = exitDeadline ?? overallDeadline;
    const pause = Math.min(pollMs, nextDeadline - deps.now());
    if (pause <= 0) break;
    await deps.sleep(pause);
  }

  deps.assertAuthority?.();
  const exit = deps.exitReason() ?? rememberedExit;
  if (exit) throw new Error(exit);
  throw new Error('浏览器启动超时');
}

export interface FixedPortDependencies {
  /** 每个可能耗时的门禁步骤后校验配置仍授权当前端口；抛错即立即中止。 */
  assertAuthority?(port: number): void;
  /** 破坏性门禁期间确认 DNS/host 地址集合仍与本轮快照一致；变化即 fail closed。 */
  assertAddressSet?(): void | Promise<void>;
  probe(port: number): Promise<ProbeResult>;
  /** 忙端口进入破坏性流程前的有界就绪宽限；运行时用于等待并发冷启动。 */
  busyGraceProbe?(port: number): Promise<ProbeResult>;
  portState(port: number): Promise<PortState>;
  listenerPids(port: number): Promise<number[]>;
  killPid(pid: number): void;
  launch?(port: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  releaseTimeoutMs?: number;
  releasePollMs?: number;
}

export type ListenerReclaimResult =
  | { state: 'free'; killFailures: string[] }
  | { state: 'busy'; killFailures: string[] }
  | { state: 'unknown'; reason: string; killFailures: string[] };

export type ListenerCleanupPlan = { action: 'kill'; pids: number[] } | { action: 'noProcess' } | { action: 'stillUp' };

type ListenerReclaimDependencies = Pick<
  FixedPortDependencies,
  | 'assertAuthority'
  | 'assertAddressSet'
  | 'listenerPids'
  | 'killPid'
  | 'portState'
  | 'sleep'
  | 'releaseTimeoutMs'
  | 'releasePollMs'
>;

/** 对全部 listener 做 best-effort 回收；单个失败不阻断其余 PID，并保留每个真因。 */
export async function killListenerPids(
  pids: number[],
  killPid: (pid: number) => void,
  beforeKill?: (pid: number) => void | Promise<void>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const pid of pids) {
    // 权威变化不是某个 PID 的 best-effort 失败；必须在破坏性操作外层立即抛出。
    await beforeKill?.(pid);
    try {
      killPid(pid);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      failures.push(`${pid}: ${detail}`);
    }
  }
  return failures;
}

/**
 * 显式 kill 也必须先证明目标端点确实 busy；否则 IPv6-only wildcard 的保守候选可能被误杀。
 * 枚举后再核对状态与 PID 快照，端点身份变化时 fail closed。
 */
export async function planListenerCleanup(
  port: number,
  deps: Pick<FixedPortDependencies, 'assertAuthority' | 'assertAddressSet' | 'portState' | 'listenerPids'>,
): Promise<ListenerCleanupPlan> {
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  const initialState = await deps.portState(port);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (initialState.state === 'free') return { action: 'noProcess' };
  if (initialState.state === 'unknown') return { action: 'stillUp' };

  const firstPids = normalizePids(await deps.listenerPids(port));
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  const finalState = await deps.portState(port);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (finalState.state === 'free') return { action: 'noProcess' };
  if (finalState.state === 'unknown') return { action: 'stillUp' };
  const finalPids = normalizePids(await deps.listenerPids(port));
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (!firstPids.length || !samePids(firstPids, finalPids)) return { action: 'stillUp' };
  return { action: 'kill', pids: finalPids };
}

/**
 * 启动后的就绪等待失败时，重新进入不含 spawn 的固定端口状态机。
 * 并发实例若已在权威端口就绪则复用；若端口最终仍可启动，则保留原始启动失败真因。
 */
export async function settleFixedPortLaunch(
  port: number,
  waitReady: () => Promise<void>,
  deps: Omit<FixedPortDependencies, 'launch'>,
): Promise<FixedPortAction> {
  try {
    await waitReady();
    assertAuthority(port, deps);
    await assertAddressSet(deps);
    return { action: 'launch', port };
  } catch (cause) {
    const recovered = await prepareFixedPort(port, deps);
    if (recovered.action === 'reuse') return recovered;
    throw cause;
  }
}

/** 尝试整组 listener 后轮询端口；调用方同时拿到最终状态与全部 kill 失败。 */
export async function reclaimFixedPortListeners(
  port: number,
  pids: number[],
  deps: ListenerReclaimDependencies,
): Promise<ListenerReclaimResult> {
  const guard = async (pid: number): Promise<void> => {
    assertAuthority(port, deps);
    await assertAddressSet(deps);
    const live = await listenerSnapshot(port, deps);
    if (!live.includes(pid)) {
      throw new FixedPortError(`配置端口 ${port} 的监听进程 ${pid} 已不再归属该端点，拒绝结束可能被复用的 PID`);
    }
  };
  const killFailures = await killListenerPids(pids, deps.killPid, guard);
  assertAuthority(port, deps);
  await assertAddressSet(deps);

  const timeoutMs = deps.releaseTimeoutMs ?? 3000;
  const pollMs = deps.releasePollMs ?? 300;
  const attempts = Math.floor(timeoutMs / pollMs);
  for (let i = 0; i <= attempts; i++) {
    assertAuthority(port, deps);
    await assertAddressSet(deps);
    const release = await deps.portState(port);
    assertAuthority(port, deps);
    await assertAddressSet(deps);
    if (release.state !== 'busy') return { ...release, killFailures };
    if (i < attempts) {
      await deps.sleep(pollMs);
      assertAuthority(port, deps);
      await assertAddressSet(deps);
    }
  }
  return { state: 'busy', killFailures };
}

/**
 * 配置端口是权威值：这里只会返回复用，或允许在传入的同一个端口启动。
 * 忙端口只有在能归属全部 listener、最终复探仍非健康、全部 kill 成功且确认释放后才可启动。
 */
export async function prepareFixedPort(port: number, deps: FixedPortDependencies): Promise<FixedPortAction> {
  return prepareFixedPortAttempt(port, deps, 0, false);
}

async function prepareFixedPortAttempt(
  port: number,
  deps: FixedPortDependencies,
  restartCount: number,
  launchChecked: boolean,
): Promise<FixedPortAction> {
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  const initial = await deps.probe(port);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (initial.ready) return { action: 'reuse', browser: initial.browser };

  const state = await deps.portState(port);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (state.state === 'free') {
    if (!deps.launch) return { action: 'launch', port };
    if (launchChecked) {
      await deps.launch(port);
      return { action: 'launch', port };
    }
    // 再走一轮完整状态判断，收紧 bind 探测与 spawn 之间的 TOCTOU 窗口。
    return prepareFixedPortAttempt(port, deps, restartCount, true);
  }
  if (state.state === 'unknown')
    throw new FixedPortError(`无法确认配置端口 ${port} 的状态: ${state.reason}，拒绝启动浏览器`);

  // 另一个并发调用可能刚 bind 端口、CDP 尚未就绪；先给有界宽限，再进入 listener 回收。
  if (deps.busyGraceProbe) {
    const graceProbe = await deps.busyGraceProbe(port);
    assertAuthority(port, deps);
    await assertAddressSet(deps);
    if (graceProbe.ready) return { action: 'reuse', browser: graceProbe.browser };
  }

  const observedPids = await listenerSnapshot(port, deps);
  assertAuthority(port, deps);
  await assertAddressSet(deps);

  // 枚举 listener 后、破坏性操作前最后再确认一次，避免误杀并发期间刚就绪的健康 CDP。
  const finalProbe = await deps.probe(port);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (finalProbe.ready) return { action: 'reuse', browser: finalProbe.browser };
  const finalState = await deps.portState(port);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (finalState.state === 'free') {
    return recheckBeforeLaunch(port, deps, restartCount);
  }
  if (finalState.state === 'unknown')
    throw new FixedPortError(`无法确认配置端口 ${port} 的状态: ${finalState.reason}，拒绝启动浏览器`);
  if (!observedPids.length)
    throw new FixedPortError(`配置端口 ${port} 已被占用，但找不到可归属的 TCP 监听进程，拒绝启动浏览器`);

  // 探活本身会花时间；复探之后重新取快照，快照变化说明端点身份可能已换，必须重启判断而非杀旧 PID。
  const currentPids = await listenerSnapshot(port, deps);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (!samePids(observedPids, currentPids)) {
    if (restartCount >= 3) throw new FixedPortError(`配置端口 ${port} 的监听进程持续变化，拒绝执行破坏性操作`);
    return prepareFixedPortAttempt(port, deps, restartCount + 1, launchChecked);
  }
  // 破坏性操作前最后复探；并发变健康就复用且绝不 kill。
  const destructiveProbe = await deps.probe(port);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (destructiveProbe.ready) return { action: 'reuse', browser: destructiveProbe.browser };
  // 探活可能耗时，必须在它之后再逐 PID 确认 listener 身份；变化时宁可重启状态机。
  const killPids = await listenerSnapshot(port, deps);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (!samePids(currentPids, killPids)) {
    if (restartCount >= 3) throw new FixedPortError(`配置端口 ${port} 的监听进程持续变化，拒绝执行破坏性操作`);
    return prepareFixedPortAttempt(port, deps, restartCount + 1, launchChecked);
  }

  const release = await reclaimFixedPortListeners(port, killPids, deps);
  assertAuthority(port, deps);
  await assertAddressSet(deps);
  if (release.state === 'free') {
    if (release.killFailures.length)
      throw new FixedPortError(
        `配置端口 ${port} 的监听进程结束失败(${release.killFailures.join('; ')})；端口现已释放，但拒绝继续启动`,
      );
    return recheckBeforeLaunch(port, deps, restartCount);
  }
  const failure = release.killFailures.length ? `；监听进程结束失败(${release.killFailures.join('; ')})` : '';
  if (release.state === 'unknown') {
    throw new FixedPortError(
      `结束监听进程后无法确认配置端口 ${port} 的状态: ${release.reason}${failure}，拒绝启动浏览器`,
    );
  }
  throw new FixedPortError(`结束监听进程后配置端口 ${port} 超时未释放${failure}，拒绝启动浏览器`);
}

async function recheckBeforeLaunch(
  port: number,
  deps: FixedPortDependencies,
  restartCount: number,
): Promise<FixedPortAction> {
  if (!deps.launch) return { action: 'launch', port };
  if (restartCount >= 3) throw new FixedPortError(`配置端口 ${port} 的状态持续变化，拒绝启动浏览器`);
  return prepareFixedPortAttempt(port, deps, restartCount + 1, true);
}

async function listenerSnapshot(port: number, deps: Pick<FixedPortDependencies, 'listenerPids'>): Promise<number[]> {
  try {
    return normalizePids(await deps.listenerPids(port));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new FixedPortError(`枚举配置端口 ${port} 的 TCP 监听进程失败: ${detail}`, { cause });
  }
}

function normalizePids(pids: number[]): number[] {
  return [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0);
}

function samePids(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(pid => rightSet.has(pid));
}

function assertAuthority(port: number, deps: Pick<FixedPortDependencies, 'assertAuthority'>): void {
  deps.assertAuthority?.(port);
}

async function assertAddressSet(deps: Pick<FixedPortDependencies, 'assertAddressSet'>): Promise<void> {
  await deps.assertAddressSet?.();
}

/** host → 数值地址集合；localhost 同时代表两种回环地址。 */
function hostAddrs(host: string): string[] {
  const normalized = canonicalAddress(host);
  return normalized === 'localhost' ? ['127.0.0.1', '::1'] : [normalized];
}

/** 把 IPv6 合法等价写法压缩成一致文本，避免 socket 可连接但 listener 字符串无法归属。 */
function canonicalAddress(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!normalized.includes(':')) return normalized;
  try {
    const canonical = new URL(`http://[${normalized}]/`).hostname.replace(/^\[/, '').replace(/\]$/, '');
    return mappedIpv4Address(canonical) ?? canonical;
  } catch {
    return normalized;
  }
}

/** URL 会把 IPv4-mapped IPv6 正规化为 `::ffff:7f00:1`；监听工具通常报告等价 IPv4。 */
function mappedIpv4Address(address: string): string | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!match) return null;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function hostFamilies(host: string): string[] {
  const families: string[] = [];
  for (const addr of hostAddrs(host)) {
    if (addr.includes('.')) families.push('IPv4');
    else if (addr.includes(':')) families.push('IPv6');
  }
  return families;
}

/** 监听地址是否服务要连接的 host:port；通配地址必须按地址族归属。 */
export function addressServes(addr: string, host: string, port: number, family?: string): boolean {
  const separator = addr.lastIndexOf(':');
  if (separator < 0 || addr.slice(separator + 1) !== String(port)) return false;
  const address = canonicalAddress(addr.slice(0, separator));
  if (hostAddrs(host).includes(address)) return true;
  const families = hostFamilies(host);
  if (address === '0.0.0.0') return families.includes('IPv4');
  if (address === '::') return families.includes('IPv6');
  if (address === '*') return family !== undefined && families.includes(family);
  return false;
}

/** 解析 Windows `netstat -ano`，只取服务目标端点的 TCP LISTENING PID。 */
export function parseNetstatListeners(out: string, port: number, host = '127.0.0.1'): number[] {
  return preferredListenerPids(parseNetstatListenerCandidates(out, port, host));
}

interface ListenerPidCandidates {
  direct: number[];
  fallback: number[];
}

function preferredListenerPids(candidates: ListenerPidCandidates): number[] {
  return candidates.direct.length ? candidates.direct : candidates.fallback;
}

function parseNetstatListenerCandidates(out: string, port: number, host: string): ListenerPidCandidates {
  const pids: number[] = [];
  const dualStackFallbackPids: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || !/^TCP$/i.test(columns[0]) || columns[3] !== 'LISTENING') continue;
    const pid = Number(columns[4]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (addressServes(columns[1], host, port)) addPid(pids, pid);
    else if (ipv6WildcardMayServeIpv4(columns[1], host, port)) addPid(dualStackFallbackPids, pid);
  }
  return { direct: pids, fallback: dualStackFallbackPids };
}

/** 解析 POSIX `lsof ... -Fpnt`，按 process/fd/type/name 状态机取目标 listener PID。 */
export function parseLsofListeners(out: string, port: number, host = '127.0.0.1'): number[] {
  return preferredListenerPids(parseLsofListenerCandidates(out, port, host));
}

function parseLsofListenerCandidates(out: string, port: number, host: string): ListenerPidCandidates {
  const pids: number[] = [];
  const dualStackFallbackPids: number[] = [];
  let currentPid = 0;
  let family = '';
  for (const line of out.split(/\r?\n/)) {
    const field = line[0];
    if (field === 'p') {
      currentPid = Number(line.slice(1).trim()) || 0;
      family = '';
      continue;
    }
    if (field === 'f') {
      family = '';
      continue;
    }
    if (field === 't') {
      family = line.slice(1).trim();
      continue;
    }
    if (field !== 'n' || !currentPid) continue;
    const address = line.slice(1).trim();
    if (addressServes(address, host, port, family)) addPid(pids, currentPid);
    else if (ipv6WildcardMayServeIpv4(address, host, port, family)) addPid(dualStackFallbackPids, currentPid);
  }
  return { direct: pids, fallback: dualStackFallbackPids };
}

/** 对 DNS 解析出的全部数值地址取 listener PID 并集。 */
export function parseLsofListenersForHosts(out: string, port: number, hosts: string[]): number[] {
  return preferredListenerPids(
    mergeListenerCandidates(hosts.map(host => parseLsofListenerCandidates(out, port, host))),
  );
}

/** 对 DNS 解析出的全部数值地址取 listener PID 并集。 */
export function parseNetstatListenersForHosts(out: string, port: number, hosts: string[]): number[] {
  return preferredListenerPids(
    mergeListenerCandidates(hosts.map(host => parseNetstatListenerCandidates(out, port, host))),
  );
}

/** 多地址必须先全局收集 direct；只有整组都无 direct 时才能采用保守 wildcard fallback。 */
function mergeListenerCandidates(candidates: ListenerPidCandidates[]): ListenerPidCandidates {
  return {
    direct: [...new Set(candidates.flatMap(candidate => candidate.direct))],
    fallback: [...new Set(candidates.flatMap(candidate => candidate.fallback))],
  };
}

function addPid(pids: number[], pid: number): void {
  if (!pids.includes(pid)) pids.push(pid);
}

/**
 * POSIX/Windows 都可能把双栈 socket 显示成 IPv6 wildcard。若已有直接匹配者，调用方只取
 * 直接匹配，避免把独立的 IPv6-only listener 一并结束；只有没有直接匹配时才用此候选兜底。
 */
function ipv6WildcardMayServeIpv4(addr: string, host: string, port: number, family?: string): boolean {
  if (!hostFamilies(host).includes('IPv4')) return false;
  const separator = addr.lastIndexOf(':');
  if (separator < 0 || addr.slice(separator + 1) !== String(port)) return false;
  const address = canonicalAddress(addr.slice(0, separator));
  return address === '::' || (address === '*' && family === 'IPv6');
}
