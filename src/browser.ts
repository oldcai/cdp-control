/**
 * browser.ts — 确保 CDP 浏览器就绪。
 * 语义:读 <CDP_HOME>/browser.json 拿到 exe/kind/args/port/userData;
 * 健康 CDP → 复用；空闲 → 同配置端口拉起；忙且非健康 → 安全回收 listener、确认释放后
 * 仍在同一配置端口拉起。绝不避让或改写端口(缺失配置时固定 bootstrap 9222)。
 * 依赖 transport + monitor + browser-discover + browser-config。不再依赖 api(无环)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { promisify } from 'node:util';
import { getJson, setEndpointHost, setPort, HOST, PORT, sleep } from './transport';
import { maybeSpawnDaemon } from './monitor';
import { cdpNoAutostart } from './paths.ts';
import { discoverCandidates, type BrowserKind } from './browser-discover';
import {
  browserConfigPath,
  parseBrowserConfig,
  defaultArgs,
  effectiveBrowserPort,
  reloadBrowserAuthority,
  DEFAULT_PORT,
  DEFAULT_USER_DATA,
  type BrowserConfig,
} from './browser-config';
import {
  prepareFixedPort,
  probePortAddresses,
  settleFixedPortLaunch,
  reclaimFixedPortListeners,
  FixedPortError,
  hasCdpWebSocket,
  lsofListenerArgs,
  parseNetstatListenersForHosts,
  parseLsofListeners,
  parseLsofListenersForHosts,
  planListenerCleanup,
  probeHostCdp,
  resolveSocketHosts,
  type FixedPortDependencies,
  type AddressPortState,
  type PortState,
  type ProbeResult,
  FixedPortLaunchAttempt,
  waitForCdpReady,
} from './browser-port';

export interface EnsureResult {
  ready: boolean;
  started: boolean;
  browser?: string;
  userData?: string;
}
export interface KillResult {
  ok: boolean;
  port: number;
  reason: 'killed' | 'noProcess' | 'killFailed' | 'stillUp' | 'noConfig' | 'broken';
}

type BrowserChild = ReturnType<typeof spawn>;

const lastLaunch = new FixedPortLaunchAttempt<BrowserChild>();
let configWriteSequence = 0;
const execFileAsync = promisify(execFile);

function terminateChild(launched: BrowserChild): void {
  try {
    if (launched.exitCode !== null || launched.signalCode !== null) return;
    if (process.platform === 'win32')
      spawn('taskkill', ['/pid', String(launched.pid), '/T', '/F'], { stdio: 'ignore' });
    else launched.kill('SIGKILL');
  } catch {
  } finally {
    lastLaunch.release(launched);
  }
}

/** 仅在真正开始下一次 spawn 时，结束上一个由本进程启动的句柄。 */
function killLast(): void {
  lastLaunch.cleanup(terminateChild);
}

function launch(exe: string, args: string[], port: number, userData: string): Promise<BrowserChild> {
  killLast();
  return new Promise((resolve, reject) => {
    let settled = false;
    const launched = spawn(exe, [...args, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
      detached: true,
      stdio: 'ignore',
    });
    lastLaunch.record(launched);
    launched.once('exit', () => lastLaunch.release(launched));
    launched.once('error', error => {
      if (settled) return;
      settled = true;
      lastLaunch.release(launched);
      reject(new Error(`启动浏览器进程失败(${exe}): ${error.message}`, { cause: error }));
    });
    // spawn 的 `'spawn'` 事件证明 OS 已成功创建进程；否则同步返回会把 ENOENT 等真因拖成“启动超时”。
    launched.once('spawn', () => {
      if (settled) return;
      settled = true;
      launched.unref();
      resolve(launched);
    });
  });
}

async function waitReady(
  timeoutMs = 20000,
  launched: BrowserChild | null = lastLaunch.launched,
  assertAuthority?: () => void,
): Promise<void> {
  let earlyExit: string | null = null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    earlyExit = `浏览器进程在 CDP 就绪前退出(code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
  };
  launched?.once('exit', onExit);
  if (launched && (launched.exitCode !== null || launched.signalCode !== null)) {
    onExit(launched.exitCode, launched.signalCode);
  }
  try {
    const dependencies = {
      probe: async (probeTimeoutMs: number) => {
        const probe = await probeReady(probeTimeoutMs);
        return probe.ready;
      },
      exitReason: () => earlyExit,
      sleep,
      now: Date.now,
      ...(assertAuthority ? { assertAuthority } : {}),
    };
    await waitForCdpReady(dependencies, timeoutMs);
  } finally {
    launched?.off('exit', onExit);
  }
}

function cdpProbeResult(value: unknown): ProbeResult {
  if (!hasCdpWebSocket(value)) return { ready: false };
  const browser =
    typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).Browser === 'string'
      ? (value as Record<string, string>).Browser
      : '';
  return { ready: true, browser: describeBrowser(browser) };
}

async function probeResolvedCdp(address: string, timeoutMs: number): Promise<ProbeResult> {
  const urlHost = address.includes(':') ? `[${address}]` : address;
  const response = await fetch(`http://${urlHost}:${Number(PORT)}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return { ready: false };
  const value: unknown = await response.json();
  return cdpProbeResult(value);
}

/**
 * ready 探活：单一数值 host 的健康主连接仍只做一次 GET；localhost/DNS 多地址
 * 则逐数值地址复核并 pin，防止健康 CDP 被 listener 并集误杀或后续连接漂到非 CDP 地址。
 */
async function probeReady(timeoutMs = 5000): Promise<ProbeResult> {
  const probe = await probeHostCdp({
    primary: async () => cdpProbeResult(await getJson('/json/version', timeoutMs)),
    resolveAddresses: resolvedSocketHosts,
    address: address => probeResolvedCdp(address, timeoutMs),
  });
  if (probe.ready && probe.address) setEndpointHost(probe.address);
  return probe;
}

/** 忙端口的并发冷启动宽限；单次请求和轮询睡眠都受同一 deadline 约束。 */
async function probeReadySoon(timeoutMs = 3000): Promise<{ ready: boolean; browser?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ready: false };
    const probe = await probeReady(Math.min(1000, remaining));
    if (probe.ready) return probe;
    const pause = Math.min(200, deadline - Date.now());
    if (pause <= 0) return { ready: false };
    await sleep(pause);
  }
}

function describeBrowser(s: string): string {
  if (/Edg\//i.test(s)) return `Microsoft Edge (${s})`;
  if (/Chrome\//i.test(s)) return `Google Chrome (${s})`;
  return s || '未知浏览器';
}

/** linux 候选名 → 绝对路径;win/mac 已绝对路径,existsSync 过滤。返回 null 表示不可用。 */
function resolveExe(exe: string): string | null {
  if (process.platform === 'linux' && !exe.includes('/')) {
    const r = spawnSync('sh', ['-c', `command -v ${exe}`], { encoding: 'utf8' });
    const p = (r.stdout || '').trim();
    return p || null;
  }
  return existsSync(exe) ? exe : null;
}

/** connect 先挡 Windows SO_REUSEADDR 的 bind 假空闲，再以严格 bind 确认真的可用。 */
async function portState(port: number): Promise<PortState> {
  let hosts: string[];
  try {
    hosts = await resolvedSocketHosts();
  } catch (cause) {
    return { state: 'unknown', reason: `解析 ${HOST} 失败: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  return probePortAddresses(port, hosts, {
    connect: connectAddressState,
    bind: bindAddressState,
  });
}

function connectAddressState(port: number, host: string): Promise<AddressPortState> {
  return new Promise(resolve => {
    const socket = connect({ port, host });
    let settled = false;
    const finish = (state: AddressPortState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1000, () =>
      finish({ address: host, state: 'unknown', code: 'ETIMEDOUT', reason: `connect ${host}:${port} ETIMEDOUT` }),
    );
    socket.once('connect', () => finish({ address: host, state: 'busy' }));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? 'UNKNOWN';
      finish(
        code === 'ECONNREFUSED'
          ? { address: host, state: 'free' }
          : { address: host, state: 'unknown', code, reason: `connect ${host}:${port} ${code}` },
      );
    });
  });
}

function bindAddressState(port: number, host: string): Promise<AddressPortState> {
  return new Promise(resolve => {
    const server = createServer();
    let settled = false;
    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {}
      finish({ address: host, state: 'unknown', code: 'ETIMEDOUT', reason: `bind ${host}:${port} ETIMEDOUT` });
    }, 1000);
    const finish = (state: AddressPortState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    // 极窄探测窗口内若有客户端连入，立即断开，避免 `server.close(cb)` 等连接结束而永久挂住。
    server.on('connection', socket => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? 'UNKNOWN';
      finish(
        code === 'EADDRINUSE'
          ? { address: host, state: 'busy' }
          : { address: host, state: 'unknown', code, reason: `bind ${host}:${port} ${code}` },
      );
    });
    server.once('listening', () =>
      server.close(error =>
        finish(
          error
            ? {
                address: host,
                state: 'unknown',
                code: 'CLOSE_FAILED',
                reason: `close bind probe ${host}:${port} ${error.message}`,
              }
            : { address: host, state: 'free' },
        ),
      ),
    );
    server.listen({ port, host, exclusive: true });
  });
}

function resolvedSocketHosts(): Promise<string[]> {
  return resolveSocketHosts(HOST, (hostname, options) => lookup(hostname, options));
}

/** 只枚举真正服务 `HOST:port` 的 TCP LISTEN listener；命令失败保留真因并由门禁拒绝继续。 */
async function listenerPids(port: number): Promise<number[]> {
  let resolvedHosts: string[] = [];
  try {
    resolvedHosts = await resolvedSocketHosts();
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano'], { encoding: 'utf8' });
      return parseNetstatListenersForHosts(stdout, port, resolvedHosts);
    }
    const { stdout } = await execFileAsync('lsof', lsofListenerArgs(port), { encoding: 'utf8' });
    return parseLsofListenersForHosts(stdout, port, resolvedHosts);
  } catch (error) {
    const stdout =
      typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string'
        ? error.stdout
        : '';
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : '';
    if (
      process.platform !== 'win32' &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 1 &&
      !stderr
    ) {
      // lsof status=1 表示没有匹配项；若同时带 stdout，仍按机器格式解析。
      return resolvedHosts.length
        ? parseLsofListenersForHosts(stdout, port, resolvedHosts)
        : parseLsofListeners(stdout, port, HOST);
    }
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
    throw new Error(`枚举配置端口 ${HOST}:${port} 的监听进程失败(${code})${stderr ? `: ${stderr}` : ''}`, {
      cause: error,
    });
  }
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`taskkill 退出码 ${result.status ?? 'unknown'}`);
    return;
  }
  process.kill(pid, 'SIGKILL');
}

type AuthorityGuard = (port: number) => void;

function fixedPortDependencies(assertAuthority?: AuthorityGuard): Omit<FixedPortDependencies, 'launch'> {
  const dependencies: Omit<FixedPortDependencies, 'launch'> = {
    probe: async () => probeReady(1000),
    busyGraceProbe: async () => probeReadySoon(3000),
    portState,
    listenerPids,
    killPid,
    sleep,
  };
  if (assertAuthority) dependencies.assertAuthority = assertAuthority;
  return dependencies;
}

function recordLaunchAttempt(attempt: FixedPortLaunchAttempt<BrowserChild>, launched: BrowserChild): BrowserChild {
  const exactLaunch = attempt.record(launched);
  launched.once('exit', () => attempt.release(launched));
  if (launched.exitCode !== null || launched.signalCode !== null) attempt.release(launched);
  return exactLaunch;
}

async function prepareAndLaunch(
  cfg: BrowserConfig,
  assertAuthority: AuthorityGuard,
  attempt: FixedPortLaunchAttempt<BrowserChild>,
): Promise<{
  decision: Awaited<ReturnType<typeof prepareFixedPort>>;
  launched: BrowserChild | null;
}> {
  setPort(cfg.port);
  let launched: BrowserChild | null = null;
  const decision = await prepareFixedPort(cfg.port, {
    ...fixedPortDependencies(assertAuthority),
    launch: async () => {
      launched = recordLaunchAttempt(attempt, await launch(cfg.exe, cfg.args, cfg.port, cfg.userData));
    },
  });
  return { decision, launched };
}

function settleLaunchedPort(
  port: number,
  assertAuthority: AuthorityGuard,
  launched: BrowserChild | null,
): ReturnType<typeof settleFixedPortLaunch> {
  return settleFixedPortLaunch(
    port,
    () => waitReady(20000, launched, () => assertAuthority(port)),
    fixedPortDependencies(assertAuthority),
  );
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code;
}

/** 读配置并同步 transport 端口。无配置固定同步 9222，并返回 null 交由调用方 bootstrap。 */
function loadConfigOrNull(): BrowserConfig | null {
  const p = browserConfigPath();
  if (!existsSync(p)) {
    setPort(DEFAULT_PORT);
    return null;
  }
  let source: string;
  try {
    source = readFileSync(p, 'utf8');
  } catch (cause) {
    if (!hasErrorCode(cause, 'ENOENT')) throw cause;
    setPort(DEFAULT_PORT);
    return null;
  }
  const cfg = parseBrowserConfig(source);
  setPort(cfg.port);
  return cfg;
}

function sameBrowserConfig(left: BrowserConfig | null, right: BrowserConfig | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.exe === right.exe &&
    left.kind === right.kind &&
    left.port === right.port &&
    left.userData === right.userData &&
    left.args.length === right.args.length &&
    left.args.every((arg, index) => arg === right.args[index])
  );
}

class BrowserAuthorityChanged extends FixedPortError {
  readonly config: BrowserConfig | null;

  constructor(config: BrowserConfig | null) {
    super('browser.json 的权威配置已变化，重新进入固定端口门禁');
    this.config = config;
  }
}

function browserAuthorityGuard(expected: BrowserConfig | null): AuthorityGuard {
  return port => {
    const current = loadConfigOrNull();
    const currentPort = effectiveBrowserPort(current);
    if (port !== currentPort || !sameBrowserConfig(expected, current)) throw new BrowserAuthorityChanged(current);
  };
}

/** bootstrap 只在 browser.json 仍不存在时原子发布，绝不覆盖并发创建的权威配置。 */
function writeBootstrapConfigAtomic(p: string, cfg: BrowserConfig): void {
  const tmp = `${p}.tmp.${process.pid}.${++configWriteSequence}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  try {
    linkSync(tmp, p);
  } catch (cause) {
    if (hasErrorCode(cause, 'EEXIST')) throw new BrowserAuthorityChanged(loadConfigOrNull());
    throw cause;
  } finally {
    try {
      unlinkSync(tmp);
    } catch (cause) {
      if (!hasErrorCode(cause, 'ENOENT')) throw cause;
    }
  }
}

/**
 * 每次探活后重读配置；端口若在请求期间变化，就切到新权威端口重新探活。
 * 只有一次探活前后的权威端口一致，调用方才可复用结果或进入回收/启动流程。
 */
async function probeAuthoritativeConfig(): Promise<{
  config: BrowserConfig | null;
  probe: Awaited<ReturnType<typeof probeReady>>;
}> {
  let config = loadConfigOrNull();
  for (let changeCount = 0; changeCount <= 3; changeCount++) {
    const observedPort = effectiveBrowserPort(config);
    // 每轮先从用户配置的 hostname 重新选端点；如果选中其它数值地址，probeReady 会 pin 住它。
    setEndpointHost(HOST);
    setPort(observedPort);
    const probe = await probeReady();
    const authority = reloadBrowserAuthority(observedPort, loadConfigOrNull, setPort);
    config = authority.config;
    if (!authority.portChanged) return { config, probe };
  }
  throw new FixedPortError('browser.json 的权威端口在探活期间持续变化，拒绝执行浏览器回收或启动');
}

type ColdStartResult =
  | { kind: BrowserKind; exe: string; userData: string }
  | { reused: true; browser?: string; userData: string };

async function coldStartAuthorityAttempt(
  cfg: BrowserConfig | null,
  launchAttempt: FixedPortLaunchAttempt<BrowserChild>,
): Promise<ColdStartResult> {
  const p = browserConfigPath();
  const assertAuthority = browserAuthorityGuard(cfg);
  assertAuthority(effectiveBrowserPort(cfg));

  if (cfg) {
    const executableExists = existsSync(cfg.exe);
    assertAuthority(cfg.port);
    if (!executableExists) throw new Error(`browser.json 的 exe 不存在: ${cfg.exe}\n请编辑 ${p}`);
    mkdirSync(cfg.userData, { recursive: true });
    let decision: Awaited<ReturnType<typeof prepareFixedPort>>;
    try {
      const prepared = await prepareAndLaunch(cfg, assertAuthority, launchAttempt);
      decision = prepared.decision;
      if (decision.action === 'reuse') return { reused: true, browser: decision.browser, userData: cfg.userData };
      const settled = await settleLaunchedPort(cfg.port, assertAuthority, prepared.launched);
      if (settled.action === 'reuse') return { reused: true, browser: settled.browser, userData: cfg.userData };
    } catch (cause) {
      if (cause instanceof BrowserAuthorityChanged) throw cause;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`浏览器未能在配置端口 ${cfg.port} 启动(${cfg.exe}): ${detail}`, { cause });
    }
    assertAuthority(cfg.port);
    maybeSpawnDaemon();
    return { kind: cfg.kind, exe: cfg.exe, userData: cfg.userData };
  }

  // 缺失 → bootstrap:默认 9222 同样是固定端口；不可用时回收或明确失败，绝不避让。
  const port = DEFAULT_PORT;
  const userData = DEFAULT_USER_DATA();
  mkdirSync(userData, { recursive: true });
  const failures: string[] = [];
  const candidates = discoverCandidates().flatMap(c => {
    const exe = resolveExe(c.exe);
    return exe ? [{ ...c, exe }] : [];
  });
  assertAuthority(port);
  if (!candidates.length) throw new Error(`未找到可用浏览器。可手动创建 ${p} 指定 exe/args`);
  for (const c of candidates) {
    const exe = c.exe;
    const args = defaultArgs();
    try {
      const prepared = await prepareAndLaunch(
        { exe, kind: c.kind, args, port, userData },
        assertAuthority,
        launchAttempt,
      );
      const decision = prepared.decision;
      if (decision.action === 'reuse') return { reused: true, browser: decision.browser, userData };
      const settled = await settleLaunchedPort(port, assertAuthority, prepared.launched);
      if (settled.action === 'reuse') return { reused: true, browser: settled.browser, userData };
    } catch (cause) {
      launchAttempt.cleanup(terminateChild);
      if (cause instanceof BrowserAuthorityChanged) throw cause;
      if (cause instanceof FixedPortError) throw cause;
      failures.push(`${exe}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    assertAuthority(port);
    const writtenConfig = { exe, kind: c.kind, args, port, userData };
    writeBootstrapConfigAtomic(p, writtenConfig);
    browserAuthorityGuard(writtenConfig)(port);
    maybeSpawnDaemon();
    return { kind: c.kind, exe, userData };
  }
  throw new Error(
    failures.length
      ? `找到浏览器但都未能在固定端口 ${port} 启动:\n${failures.join('\n')}\n可手动创建 ${p} 指定 exe/args`
      : `未找到可用浏览器。可手动创建 ${p} 指定 exe/args`,
  );
}

/** 单轮冷启动只清理由本轮实际 spawn 的句柄；未启动时绝不触碰进程内历史浏览器。 */
async function coldStartWithAuthority(cfg: BrowserConfig | null): Promise<ColdStartResult> {
  const launchAttempt = new FixedPortLaunchAttempt<BrowserChild>();
  try {
    return await coldStartAuthorityAttempt(cfg, launchAttempt);
  } catch (cause) {
    launchAttempt.cleanup(terminateChild);
    throw cause;
  }
}

/** 冷启动:有配置则用(坏则抛,不兜底);无配置则在固定默认端口 bootstrap。 */
async function coldStart(initialConfig: BrowserConfig | null): Promise<ColdStartResult> {
  let config = initialConfig;
  for (let changeCount = 0; changeCount <= 3; changeCount++) {
    try {
      return await coldStartWithAuthority(config);
    } catch (cause) {
      if (!(cause instanceof BrowserAuthorityChanged)) throw cause;
      config = cause.config;
    }
  }
  throw new FixedPortError('browser.json 的权威配置持续变化，拒绝执行浏览器回收或启动');
}

/** 确保有 CDP 浏览器在跑：就绪时安全复用，未就绪自动拉起。 */
export async function ensureBrowser(): Promise<EnsureResult> {
  // 探活前后都重读权威配置；无配置时固定 9222，不能继承 CDP_PORT 等漂移值。
  let state: Awaited<ReturnType<typeof probeAuthoritativeConfig>>;
  try {
    state = await probeAuthoritativeConfig();
  } catch (cause) {
    if (cause instanceof FixedPortError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${detail}\n浏览器启动配置损坏,不做兜底,请编辑 ${browserConfigPath()}`, { cause });
  }
  const cfg = state.config;
  if (cfg?.userData) mkdirSync(cfg.userData, { recursive: true });
  if (state.probe.ready) return { ready: true, started: false, browser: state.probe.browser, userData: cfg?.userData };
  // 集成 harness/连接专用模式必须保持进程所有权：端点掉线就报错，不拉起 detached 浏览器/daemon。
  if (cdpNoAutostart()) {
    throw new Error(`CDP_NO_AUTOSTART=1: 端点 ${HOST}:${Number(PORT)} 未就绪，拒绝自动启动浏览器`);
  }
  const info = await coldStart(cfg);
  if ('reused' in info) return { ready: true, started: false, browser: info.browser, userData: info.userData };
  console.error(`已自动启动浏览器: ${describeBrowser(info.exe)} (端口 ${Number(PORT)})`);
  return { ready: true, started: true, browser: describeBrowser(info.exe), userData: info.userData };
}

/** 强制结束浏览器进程:端口从 browser.json 读;无配置则 kill 不生效。返回是否已无监听。 */
export async function killBrowser(): Promise<KillResult> {
  const p = browserConfigPath();
  if (!existsSync(p)) return { ok: false, port: 9222, reason: 'noConfig' };
  let cfg: BrowserConfig;
  try {
    cfg = parseBrowserConfig(readFileSync(p, 'utf8'));
  } catch {
    return { ok: false, port: 9222, reason: 'broken' };
  }
  const port = cfg.port;
  const assertAuthority = browserAuthorityGuard(cfg);
  const plan = await planListenerCleanup(port, { assertAuthority, portState, listenerPids });
  if (plan.action === 'noProcess') return { ok: true, port, reason: 'noProcess' };
  if (plan.action === 'stillUp') return { ok: false, port, reason: 'stillUp' };
  const release = await reclaimFixedPortListeners(port, plan.pids, { assertAuthority, killPid, portState, sleep });
  if (release.state !== 'free') return { ok: false, port, reason: 'stillUp' };
  return release.killFailures.length ? { ok: false, port, reason: 'killFailed' } : { ok: true, port, reason: 'killed' };
}
