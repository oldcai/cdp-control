/**
 * monitor.ts — 控制台监听:常驻注入守护 daemon(cmdListen)+ 读取(logs)。
 * 依赖 transport(连接原语)+ inject-loader(monitor/read 注入装配),不依赖 api → 无环。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pageWs, send, listTargets, resolve, evaluate, sleep, PORT, HOST, Target } from './transport';
import { inject, readExpr } from './inject-loader';
import { cdpHome, cdpLogsPort, cdpNoAutostart } from './paths.ts';
import {
  daemonHealthy as probeDaemonHealth,
  daemonIdentity,
  daemonPidFilePath,
  ensureDaemonReady,
  type DaemonIdentity,
} from './monitor-health.ts';
import { legacyDaemonPidFilePath, retireDaemonProcess } from './monitor-process';
import { initializeBoundDaemon } from './monitor-startup.ts';

export const LOGS_PORT = cdpLogsPort();

export function pidFilePath(): string {
  return daemonPidFilePath();
}

async function spawnDaemon(): Promise<void> {
  const script = daemonScriptPath();
  // 把当前浏览器端口(经 ensureBrowser 从 browser.json 同步的 PORT)注入 daemon,daemon 连对端口。
  const child = spawn(process.execPath, [script, '__daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CDP_PORT: String(PORT) },
  });
  child.unref();
}

function daemonScriptPath(): string {
  return process.argv[1] || __filename;
}

function currentDaemonIdentity(): DaemonIdentity {
  return daemonIdentity(process.env, undefined, HOST, PORT);
}

export async function daemonHealthy(port = LOGS_PORT): Promise<boolean> {
  return probeDaemonHealth(port, currentDaemonIdentity());
}

// 异步确保 daemon 在跑(打开页面时自动注入守护;失败不阻塞主流程)。
export async function maybeSpawnDaemon(): Promise<void> {
  if (cdpNoAutostart()) return;
  try {
    await ensureDaemon();
  } catch {}
}

export async function ensureDaemon(port = LOGS_PORT): Promise<number> {
  await ensureDaemonReady(port, currentDaemonIdentity(), {
    fetchImpl: fetch,
    retireDaemonImpl: kind =>
      retireDaemonProcess(port, daemonScriptPath(), kind === 'legacy' ? legacyDaemonPidFilePath() : pidFilePath()),
    sleepImpl: sleep,
    spawnImpl: spawnDaemon,
  });
  return port;
}

/**
 * 给已连的页面 WS 装上监控:Page.enable + 注册 addScriptToEvaluateOnNewDocument(未来
 * 每个 document 自动跑)+ 立即对当前已加载页 Runtime.evaluate 注入一次。幂等(哨兵)。
 */
async function attachInject(ws: WebSocket): Promise<void> {
  const mon = inject('monitor');
  await send(ws, 'Page.enable', {}, 5000);
  await send(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: mon }, 5000);
  await send(ws, 'Runtime.evaluate', { expression: mon, returnByValue: true }, 5000);
}

/**
 * 注入守护 daemon(隐藏 __daemon 命令,spawnDaemon 自重生入口)。不做日志缓冲/读取——
 * 职责是保证**每个 tab 都装上页面监控脚本**。attach 时 Page.addScriptToEvaluateOnNewDocument
 * 注册一次,之后每次 document 创建(含刷新)自动重跑监控脚本 → 刷新自动补,无需探测。
 * 轮询 /json/list 自动覆盖新开的 tab(含手动开的)。读取交给 logs 命令去 eval 页面 window.__cdpLogs。
 */
export async function cmdListen(): Promise<never> {
  const attached = new Map<string, WebSocket>();
  const identity = currentDaemonIdentity();

  async function injectMon(target: Target): Promise<void> {
    let ws: WebSocket;
    try {
      ws = await pageWs(target);
    } catch {
      return;
    }
    attached.set(target.id, ws);
    ws.onclose = () => attached.delete(target.id);
    try {
      await attachInject(ws);
    } catch {}
  }

  // 看门狗:浏览器被关掉后 /json/list 会持续探测失败。连续 WATCHDOG_POLLS 次(约 5s)
  // 失败 → 自动退出,不留孤儿 daemon(下次 open/ensure/logs 会自动重新拉起)。
  let deadPolls = 0;
  const WATCHDOG_POLLS = 10;
  async function sync(): Promise<void> {
    let list: Target[];
    try {
      list = await listTargets();
    } catch {
      deadPolls++;
      if (deadPolls >= WATCHDOG_POLLS) {
        try {
          unlinkSync(pidFilePath());
        } catch {}
        process.exit(0);
      }
      return;
    }
    deadPolls = 0;
    for (const t of list) if (!attached.has(t.id)) await injectMon(t);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${LOGS_PORT}`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, identity, targets: attached.size }));
      return;
    }
    if (url.pathname === '/shutdown') {
      try {
        unlinkSync(pidFilePath());
      } catch {}
      server.close();
      process.exit(0);
    }
    res.statusCode = 404;
    res.end('{}');
  });

  await initializeBoundDaemon({
    bind: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(LOGS_PORT, '127.0.0.1', resolve);
      }),
    publishPid: () => {
      mkdirSync(cdpHome(), { recursive: true });
      writeFileSync(pidFilePath(), String(process.pid));
    },
    syncInitialTargets: sync,
  });
  setInterval(() => {
    sync().catch(() => {});
  }, 500);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  console.error(`注入守护 daemon 就绪 :${LOGS_PORT},tabs=${attached.size}`);
  return new Promise<never>(() => {});
}

export interface LogsOpts {
  level?: string;
  since?: number;
}

export interface LogEntry {
  ts: number;
  type: string;
  level: string;
  args?: unknown[];
  stack?: string;
  message?: string;
  source?: string;
  line?: number;
  col?: number;
  reason?: unknown;
}

function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<LogEntry>;
  return typeof entry.ts === 'number' && typeof entry.type === 'string' && typeof entry.level === 'string';
}

/**
 * 读 target 的控制台日志:幂等注入监控脚本 + 读取 window.__cdpLogs(结构化嵌套对象)。
 */
export async function logs(target: Target | string, opts: LogsOpts = {}): Promise<LogEntry[]> {
  maybeSpawnDaemon().catch(() => {});
  if (typeof target === 'string') target = await resolve(target);
  const levelSet = opts.level
    ? opts.level
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    : null;
  const since = opts.since || 0;
  const value = await evaluate(target, readExpr(levelSet, since), 30000);
  return Array.isArray(value) ? value.filter(isLogEntry) : [];
}

/**
 * 一次性给 target 装上监控(注册 addScript + 立即注入),然后关 WS。
 * 用于 open() 直接注入,不等 daemon 轮询(0.5-2s)。
 */
export async function injectMonitor(target: Target): Promise<boolean> {
  let ws: WebSocket;
  try {
    ws = await pageWs(target);
  } catch {
    return false;
  }
  try {
    await attachInject(ws);
  } catch {}
  ws.close();
  return true;
}
