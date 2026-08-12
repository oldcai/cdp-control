/**
 * browser-port.ts — 固定 CDP 端口的状态判断、监听者解析与安全回收编排。
 * 网络/进程副作用由 browser.ts 注入；核心状态机可纯单测。
 */

export interface ProbeResult { ready: boolean; browser?: string; }
export type PortState = { state: 'free' } | { state: 'busy' } | { state: 'unknown'; reason: string };
export type FixedPortAction = { action: 'reuse'; browser?: string } | { action: 'launch'; port: number };

/** 端口门禁失败；调用方据此区分“不得继续”的安全错误与某个浏览器候选自身启动失败。 */
export class FixedPortError extends Error {}

/** `/json/version` 只有给出真正的 ws/wss 调试地址才算健康 CDP。 */
export function hasCdpWebSocket(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const websocket = (value as Record<string, unknown>).webSocketDebuggerUrl;
  if (typeof websocket !== 'string' || !websocket.trim()) return false;
  try {
    const protocol = new URL(websocket).protocol;
    return protocol === 'ws:' || protocol === 'wss:';
  } catch { return false; }
}

export function lsofListenerArgs(port: number): string[] {
  return ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpnt'];
}

export interface FixedPortDependencies {
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
  const initial = await deps.probe(port);
  if (initial.ready) return { action: 'reuse', browser: initial.browser };

  const state = await deps.portState(port);
  if (state.state === 'free') {
    if (!deps.launch) return { action: 'launch', port };
    if (launchChecked) {
      await deps.launch(port);
      return { action: 'launch', port };
    }
    // 再走一轮完整状态判断，收紧 bind 探测与 spawn 之间的 TOCTOU 窗口。
    return prepareFixedPortAttempt(port, deps, restartCount, true);
  }
  if (state.state === 'unknown') throw new FixedPortError(`无法确认配置端口 ${port} 的状态: ${state.reason}，拒绝启动浏览器`);

  // 另一个并发调用可能刚 bind 端口、CDP 尚未就绪；先给有界宽限，再进入 listener 回收。
  if (deps.busyGraceProbe) {
    const graceProbe = await deps.busyGraceProbe(port);
    if (graceProbe.ready) return { action: 'reuse', browser: graceProbe.browser };
  }

  const observedPids = await listenerSnapshot(port, deps);

  // 枚举 listener 后、破坏性操作前最后再确认一次，避免误杀并发期间刚就绪的健康 CDP。
  const finalProbe = await deps.probe(port);
  if (finalProbe.ready) return { action: 'reuse', browser: finalProbe.browser };
  const finalState = await deps.portState(port);
  if (finalState.state === 'free') {
    return recheckBeforeLaunch(port, deps, restartCount);
  }
  if (finalState.state === 'unknown') throw new FixedPortError(`无法确认配置端口 ${port} 的状态: ${finalState.reason}，拒绝启动浏览器`);
  if (!observedPids.length) throw new FixedPortError(`配置端口 ${port} 已被占用，但找不到可归属的 TCP 监听进程，拒绝启动浏览器`);

  // 探活本身会花时间；复探之后重新取快照，快照变化说明端点身份可能已换，必须重启判断而非杀旧 PID。
  const currentPids = await listenerSnapshot(port, deps);
  if (!samePids(observedPids, currentPids)) {
    if (restartCount >= 3) throw new FixedPortError(`配置端口 ${port} 的监听进程持续变化，拒绝执行破坏性操作`);
    return prepareFixedPortAttempt(port, deps, restartCount + 1, launchChecked);
  }
  // 破坏性操作前最后复探；并发变健康就复用且绝不 kill。
  const destructiveProbe = await deps.probe(port);
  if (destructiveProbe.ready) return { action: 'reuse', browser: destructiveProbe.browser };
  // 探活可能耗时，必须在它之后再逐 PID 确认 listener 身份；变化时宁可重启状态机。
  const killPids = await listenerSnapshot(port, deps);
  if (!samePids(currentPids, killPids)) {
    if (restartCount >= 3) throw new FixedPortError(`配置端口 ${port} 的监听进程持续变化，拒绝执行破坏性操作`);
    return prepareFixedPortAttempt(port, deps, restartCount + 1, launchChecked);
  }

  const killFailures: string[] = [];
  for (const pid of killPids) {
    try { deps.killPid(pid); }
    catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      killFailures.push(`${pid}: ${detail}`);
    }
  }

  const timeoutMs = deps.releaseTimeoutMs ?? 3000;
  const pollMs = deps.releasePollMs ?? 300;
  const attempts = Math.floor(timeoutMs / pollMs);
  for (let i = 0; i <= attempts; i++) {
    const release = await deps.portState(port);
    if (release.state === 'free') {
      if (killFailures.length) throw new FixedPortError(`配置端口 ${port} 的监听进程结束失败(${killFailures.join('; ')})；端口现已释放，但拒绝继续启动`);
      return recheckBeforeLaunch(port, deps, restartCount);
    }
    if (release.state === 'unknown') {
      const failure = killFailures.length ? `；监听进程结束失败(${killFailures.join('; ')})` : '';
      throw new FixedPortError(`结束监听进程后无法确认配置端口 ${port} 的状态: ${release.reason}${failure}，拒绝启动浏览器`);
    }
    if (i < attempts) await deps.sleep(pollMs);
  }
  const failure = killFailures.length ? `；监听进程结束失败(${killFailures.join('; ')})` : '';
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

async function listenerSnapshot(port: number, deps: FixedPortDependencies): Promise<number[]> {
  try {
    return [...new Set(await deps.listenerPids(port))].filter(pid => Number.isInteger(pid) && pid > 0);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new FixedPortError(`枚举配置端口 ${port} 的 TCP 监听进程失败: ${detail}`, { cause });
  }
}

function samePids(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(pid => rightSet.has(pid));
}

/** host → 数值地址集合；localhost 同时代表两种回环地址。 */
function hostAddrs(host: string): string[] {
  const normalized = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return normalized === 'localhost' ? ['127.0.0.1', '::1'] : [normalized];
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
  const address = addr.slice(0, separator).replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (hostAddrs(host).includes(address)) return true;
  const families = hostFamilies(host);
  if (address === '0.0.0.0') return families.includes('IPv4');
  if (address === '::') return families.includes('IPv6');
  if (address === '*') return family !== undefined && families.includes(family);
  return false;
}

/** 解析 Windows `netstat -ano`，只取服务目标端点的 TCP LISTENING PID。 */
export function parseNetstatListeners(out: string, port: number, host = '127.0.0.1'): number[] {
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
  return pids.length ? pids : dualStackFallbackPids;
}

/** 解析 POSIX `lsof ... -Fpnt`，按 process/fd/type/name 状态机取目标 listener PID。 */
export function parseLsofListeners(out: string, port: number, host = '127.0.0.1'): number[] {
  const pids: number[] = [];
  const dualStackFallbackPids: number[] = [];
  let currentPid = 0;
  let family = '';
  for (const line of out.split(/\r?\n/)) {
    const field = line[0];
    if (field === 'p') { currentPid = Number(line.slice(1).trim()) || 0; family = ''; continue; }
    if (field === 'f') { family = ''; continue; }
    if (field === 't') { family = line.slice(1).trim(); continue; }
    if (field !== 'n' || !currentPid) continue;
    const address = line.slice(1).trim();
    if (addressServes(address, host, port, family)) addPid(pids, currentPid);
    else if (ipv6WildcardMayServeIpv4(address, host, port, family)) addPid(dualStackFallbackPids, currentPid);
  }
  return pids.length ? pids : dualStackFallbackPids;
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
  const address = addr.slice(0, separator).replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return address === '::' || (address === '*' && family === 'IPv6');
}
