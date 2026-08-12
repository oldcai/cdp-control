/**
 * browser.ts — 确保 CDP 浏览器就绪。
 * 语义:读 ~/.cdp-control/browser.json 拿到 exe/kind/args/port/userData;
 * 健康 CDP → 复用；空闲 → 同配置端口拉起；忙且非健康 → 安全回收 listener、确认释放后
 * 仍在同一配置端口拉起。绝不避让或改写端口(缺失配置时固定 bootstrap 9222)。
 * 依赖 transport + monitor + browser-discover + browser-config。不再依赖 api(无环)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { promisify } from 'node:util';
import { getJson, setPort, HOST, PORT, sleep } from './transport';
import { maybeSpawnDaemon } from './monitor';
import { discoverCandidates, type BrowserKind } from './browser-discover';
import { browserConfigPath, parseBrowserConfig, defaultArgs, effectiveBrowserPort, DEFAULT_PORT, DEFAULT_USER_DATA, type BrowserConfig } from './browser-config';
import {
  prepareFixedPort,
  FixedPortError,
  hasCdpWebSocket,
  lsofListenerArgs,
  parseNetstatListeners,
  parseLsofListeners,
  type PortState,
} from './browser-port';

export interface EnsureResult { ready: boolean; started: boolean; browser?: string; userData?: string; }
export interface KillResult { ok: boolean; port: number; reason: 'killed' | 'noProcess' | 'stillUp' | 'noConfig' | 'broken'; }

let child: ReturnType<typeof spawn> | null = null;
const execFileAsync = promisify(execFile);

/** 杀掉上次 bootstrap 尝试的进程(仅多候选降级时用)。 */
function killLast(): void {
  if (!child) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {}
  child = null;
}

function launch(exe: string, args: string[], port: number, userData: string): Promise<void> {
  killLast();
  return new Promise((resolve, reject) => {
    let settled = false;
    const launched = spawn(exe, [...args, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { detached: true, stdio: 'ignore' });
    child = launched;
    launched.once('error', error => {
      if (settled) return;
      settled = true;
      if (child === launched) child = null;
      reject(new Error(`启动浏览器进程失败(${exe}): ${error.message}`, { cause: error }));
    });
    // spawn 的 `'spawn'` 事件证明 OS 已成功创建进程；否则同步返回会把 ENOENT 等真因拖成“启动超时”。
    launched.once('spawn', () => {
      if (settled) return;
      settled = true;
      launched.unref();
      resolve();
    });
  });
}

async function waitReady(timeoutMs = 20000, launched: ReturnType<typeof spawn> | null = child): Promise<void> {
  let earlyExit: string | null = null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    earlyExit = `浏览器进程在 CDP 就绪前退出(code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
  };
  launched?.once('exit', onExit);
  if (launched && (launched.exitCode !== null || launched.signalCode !== null)) {
    onExit(launched.exitCode, launched.signalCode);
  }
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < timeoutMs) {
      if (earlyExit) throw new Error(earlyExit);
      try { const v: unknown = await getJson('/json/version'); if (hasCdpWebSocket(v)) return; } catch {}
      await new Promise(r => setTimeout(r, 400));
    }
    if (earlyExit) throw new Error(earlyExit);
    throw new Error('浏览器启动超时');
  } finally {
    launched?.off('exit', onExit);
  }
}

/** ready 探活(一次 GET,顺带拿浏览器名)。 */
async function probeReady(timeoutMs?: number): Promise<{ ready: boolean; browser?: string }> {
  try {
    const v: unknown = await getJson('/json/version', timeoutMs);
    if (!hasCdpWebSocket(v)) return { ready: false };
    const browser = typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).Browser === 'string'
      ? (v as Record<string, string>).Browser : '';
    return { ready: true, browser: describeBrowser(browser) };
  } catch { return { ready: false }; }
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

function writeConfigAtomic(p: string, cfg: BrowserConfig): void {
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, p);
}

/** connect 先挡 Windows SO_REUSEADDR 的 bind 假空闲，再以严格 bind 确认真的可用。 */
async function portState(port: number): Promise<PortState> {
  const connected = await connectState(port);
  if (connected.state !== 'free') return connected;
  return bindState(port);
}

function connectState(port: number): Promise<PortState> {
  return new Promise(resolve => {
    const socket = connect({ port, host: HOST });
    let settled = false;
    const finish = (state: PortState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1000, () => finish({ state: 'unknown', reason: `connect ${HOST}:${port} ETIMEDOUT` }));
    socket.once('connect', () => finish({ state: 'busy' }));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'
      ? { state: 'free' }
      : { state: 'unknown', reason: `connect ${HOST}:${port} ${error.code ?? error.message}` }));
  });
}

function bindState(port: number): Promise<PortState> {
  return new Promise(resolve => {
    const server = createServer();
    let settled = false;
    const timer = setTimeout(() => {
      try { server.close(); } catch {}
      finish({ state: 'unknown', reason: `bind ${HOST}:${port} ETIMEDOUT` });
    }, 1000);
    const finish = (state: PortState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    // 极窄探测窗口内若有客户端连入，立即断开，避免 `server.close(cb)` 等连接结束而永久挂住。
    server.on('connection', socket => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'EADDRINUSE'
      ? { state: 'busy' }
      : { state: 'unknown', reason: `bind ${HOST}:${port} ${error.code ?? error.message}` }));
    server.once('listening', () => server.close(error => finish(error
      ? { state: 'unknown', reason: `close bind probe ${HOST}:${port} ${error.message}` }
      : { state: 'free' })));
    server.listen({ port, host: HOST, exclusive: true });
  });
}

/** 只枚举真正服务 `HOST:port` 的 TCP LISTEN listener；命令失败保留真因并由门禁拒绝继续。 */
async function listenerPids(port: number): Promise<number[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano'], { encoding: 'utf8' });
      return parseNetstatListeners(stdout, port, HOST);
    }
    const { stdout } = await execFileAsync('lsof', lsofListenerArgs(port), { encoding: 'utf8' });
    return parseLsofListeners(stdout, port, HOST);
  } catch (error) {
    const stdout = typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string'
      ? error.stdout : '';
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim() : '';
    if (process.platform !== 'win32' && typeof error === 'object' && error !== null && 'code' in error && error.code === 1 && !stderr) {
      // lsof status=1 表示没有匹配项；若同时带 stdout，仍按机器格式解析。
      return parseLsofListeners(stdout, port, HOST);
    }
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
    throw new Error(`枚举配置端口 ${HOST}:${port} 的监听进程失败(${code})${stderr ? `: ${stderr}` : ''}`, { cause: error });
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

function prepareAndLaunch(cfg: BrowserConfig): ReturnType<typeof prepareFixedPort> {
  setPort(cfg.port);
  return prepareFixedPort(cfg.port, {
    probe: async () => probeReady(1000),
    busyGraceProbe: async () => probeReadySoon(3000),
    portState,
    listenerPids,
    killPid,
    launch: async () => launch(cfg.exe, cfg.args, cfg.port, cfg.userData),
    sleep,
  });
}

/** 读配置并同步 transport 端口。无配置返回 null(交由调用方 bootstrap)。 */
function loadConfigOrNull(): BrowserConfig | null {
  const p = browserConfigPath();
  if (!existsSync(p)) return null;
  const cfg = parseBrowserConfig(readFileSync(p, 'utf8'));
  setPort(cfg.port);
  return cfg;
}

type ColdStartResult = { kind: BrowserKind; exe: string; userData: string } | { reused: true; browser?: string; userData: string };

/** 冷启动:有配置则用(坏则抛,不兜底);无配置则在固定默认端口 bootstrap。 */
async function coldStart(cfg: BrowserConfig | null): Promise<ColdStartResult> {
  const p = browserConfigPath();

  if (cfg) {
    if (!existsSync(cfg.exe)) throw new Error(`browser.json 的 exe 不存在: ${cfg.exe}\n请编辑 ${p}`);
    mkdirSync(cfg.userData, { recursive: true });
    let decision: Awaited<ReturnType<typeof prepareFixedPort>>;
    try {
      decision = await prepareAndLaunch(cfg);
      if (decision.action === 'reuse') return { reused: true, browser: decision.browser, userData: cfg.userData };
      await waitReady();
    }
    catch (cause) {
      killLast();
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`浏览器未能在配置端口 ${cfg.port} 启动(${cfg.exe}): ${detail}`, { cause });
    }
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
  if (!candidates.length) throw new Error(`未找到可用浏览器。可手动创建 ${p} 指定 exe/args`);
  for (const c of candidates) {
    const exe = c.exe;
    const args = defaultArgs();
    try {
      const decision = await prepareAndLaunch({ exe, kind: c.kind, args, port, userData });
      if (decision.action === 'reuse') return { reused: true, browser: decision.browser, userData };
      await waitReady();
    }
    catch (cause) {
      killLast();
      if (cause instanceof FixedPortError) throw cause;
      failures.push(`${exe}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    writeConfigAtomic(p, { exe, kind: c.kind, args, port, userData });
    maybeSpawnDaemon();
    return { kind: c.kind, exe, userData };
  }
  throw new Error(failures.length
    ? `找到浏览器但都未能在固定端口 ${port} 启动:\n${failures.join('\n')}\n可手动创建 ${p} 指定 exe/args`
    : `未找到可用浏览器。可手动创建 ${p} 指定 exe/args`);
}

/** 确保有 CDP 浏览器在跑:就绪零开销(1 GET);未就绪自动拉起。 */
export async function ensureBrowser(): Promise<EnsureResult> {
  // 无配置也必须把 transport 恢复到权威默认 9222，不能继承 CDP_PORT 等漂移值。
  let cfg: BrowserConfig | null;
  try { cfg = loadConfigOrNull(); }
  catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${detail}\n浏览器启动配置损坏,不做兜底,请编辑 ${browserConfigPath()}`, { cause });
  }
  setPort(effectiveBrowserPort(cfg));
  if (cfg?.userData) mkdirSync(cfg.userData, { recursive: true });
  const probe = await probeReady();
  if (probe.ready) return { ready: true, started: false, browser: probe.browser, userData: cfg?.userData };
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
  try { cfg = parseBrowserConfig(readFileSync(p, 'utf8')); }
  catch { return { ok: false, port: 9222, reason: 'broken' }; }
  const port = cfg.port;
  const pids = await listenerPids(port);
  for (const pid of pids) {
    try { killPid(pid); }
    catch { return { ok: false, port, reason: 'stillUp' }; }
  }
  for (let i = 0; i <= 10; i++) {
    const state = await portState(port);
    if (state.state === 'free') return { ok: true, port, reason: pids.length ? 'killed' : 'noProcess' };
    if (state.state === 'unknown') return { ok: false, port, reason: 'stillUp' };
    if (i < 10) await sleep(300);
  }
  return { ok: false, port, reason: 'stillUp' };
}
