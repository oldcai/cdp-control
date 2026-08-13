/**
 * monitor.ts — 控制台监听:常驻注入守护 daemon(cmdListen)+ 读取(logs)。
 * 依赖 transport(连接原语)+ inject-loader(monitor/read 注入装配),不依赖 api → 无环。
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  pageWs,
  send,
  listTargets,
  resolve,
  evaluate,
  sleep,
  isEndpointPinned,
  pinEndpointFromEnvironment,
  CONNECTION_HOST,
  PORT,
  type Target,
} from './transport.ts';
import { inject, readExpr } from './inject-loader.ts';
import { cdpHome, cdpLogsPort, cdpNoAutostart } from './paths.ts';
import {
  daemonHealthPayloads,
  daemonHealthy as probeDaemonHealth,
  daemonIdentity,
  daemonPidFilePath,
  ensureDaemonReady,
  type DaemonIdentity,
  type DaemonPhase,
  type RetirableDaemonCandidate,
} from './monitor-health.ts';
import { daemonChildEnvironment } from './monitor-endpoint.ts';
import { runMonitorAutostart } from './monitor-diagnostics.ts';
import { AttachmentRegistry } from './monitor-attachments.ts';
import { legacyDaemonPidFilePath, retireDaemonProcess } from './monitor-process.ts';
import { initializeBoundDaemon } from './monitor-startup.ts';
import { processBirthIdentity } from './process-identity.ts';
import { spawnDetachedDaemon } from './monitor-spawn.ts';
import {
  MONITOR_ATTACH_BATCH_SIZE,
  MONITOR_CDP_COMMAND_TIMEOUT_MS,
  MONITOR_TARGET_LIST_TIMEOUT_MS,
  MONITOR_WEBSOCKET_CONNECT_TIMEOUT_MS,
} from './monitor-timing.ts';

export const LOGS_PORT = cdpLogsPort();

export function pidFilePath(): string {
  return daemonPidFilePath();
}

async function spawnDaemon(identity: DaemonIdentity, logsPort: number): Promise<void> {
  const script = daemonScriptPath();
  // 使用 ensureDaemon 同一次快照，避免异步等待期间全局连接端点变化后 identity 与 child env 分裂。
  await spawnDetachedDaemon(
    process.execPath,
    [script, '__daemon'],
    daemonChildEnvironment(process.env, identity, logsPort),
  );
}

function daemonScriptPath(): string {
  return process.argv[1] || __filename;
}

/** 未 pin 端点时拒绝计算身份的稳定前缀；autostart 诊断按此断言。 */
export const UNPINNED_ENDPOINT_ERROR = 'CDP 端点尚未 pin 到权威配置';

/**
 * 逻辑身份 = 规范化 home + **已 pin 的 host** + **权威 port**。transport 的 HOST/PORT 在 ensureBrowser
 * 同步 browser.json 之前只是 env 猜测,用它算身份会把服务权威端口(如 9223)的健康 daemon 判成
 * 同 home 异 endpoint 的 owned-stale,而五重接管门禁全部为真(它确实是我们的 daemon,只是判错了谁 stale)
 * → SIGTERM 杀掉健康 watcher。身份是破坏性动作的前提,所以未 pin 一律 fail closed,宁可不发生。
 */
export function currentDaemonIdentity(): DaemonIdentity {
  if (!isEndpointPinned()) throw new Error(`${UNPINNED_ENDPOINT_ERROR},拒绝在未确定 endpoint 时判定 daemon 身份`);
  return daemonIdentity(process.env, undefined, CONNECTION_HOST, PORT);
}

export async function daemonHealthy(port = LOGS_PORT): Promise<boolean> {
  return probeDaemonHealth(port, currentDaemonIdentity());
}

export interface MaybeSpawnDaemonOptions {
  ensureDaemonImpl?: () => Promise<number>;
  environment?: NodeJS.ProcessEnv;
  reportError?: (message: string) => void;
}

// 异步确保 daemon 在跑(打开页面时自动注入守护;失败不阻塞主流程，但必须可诊断)。
export async function maybeSpawnDaemon(options: MaybeSpawnDaemonOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  await runMonitorAutostart(options.ensureDaemonImpl ?? ensureDaemon, {
    disabled: cdpNoAutostart(environment),
    reportError: options.reportError,
  });
}

function candidateAuthority(candidate: RetirableDaemonCandidate): { pid: number; birth: string } | undefined {
  return typeof candidate === 'object' && candidate.protocol === 'v1' ? candidate.instance : undefined;
}

export async function ensureDaemon(port = LOGS_PORT): Promise<number> {
  const identity = currentDaemonIdentity();
  const ownedPidFile = daemonPidFilePath({ CDP_HOME: identity.home });
  await ensureDaemonReady(port, identity, {
    fetchImpl: fetch,
    retireDaemonImpl: candidate =>
      retireDaemonProcess(
        port,
        daemonScriptPath(),
        candidate === 'legacy' ? legacyDaemonPidFilePath() : ownedPidFile,
        candidateAuthority(candidate),
      ),
    sleepImpl: sleep,
    spawnImpl: () => spawnDaemon(identity, port),
  });
  return port;
}

/**
 * 给已连的页面 WS 装上监控:Page.enable + 注册 addScriptToEvaluateOnNewDocument(未来
 * 每个 document 自动跑)+ 立即对当前已加载页 Runtime.evaluate 注入一次。幂等(哨兵)。
 */
async function attachInject(ws: WebSocket): Promise<void> {
  const mon = inject('monitor');
  await send(ws, 'Page.enable', {}, MONITOR_CDP_COMMAND_TIMEOUT_MS);
  await send(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: mon }, MONITOR_CDP_COMMAND_TIMEOUT_MS);
  await send(ws, 'Runtime.evaluate', { expression: mon, returnByValue: true }, MONITOR_CDP_COMMAND_TIMEOUT_MS);
}

/**
 * 注入守护 daemon(隐藏 __daemon 命令,spawnDaemon 自重生入口)。不做日志缓冲/读取——
 * 职责是保证**每个 tab 都装上页面监控脚本**。attach 时 Page.addScriptToEvaluateOnNewDocument
 * 注册一次,之后每次 document 创建(含刷新)自动重跑监控脚本 → 刷新自动补,无需探测。
 * 轮询 /json/list 自动覆盖新开的 tab(含手动开的)。读取交给 logs 命令去 eval 页面 window.__cdpLogs。
 */
export async function cmdListen(): Promise<never> {
  // daemon 不跑 ensureBrowser(monitor 与 browser 同层,不得反向依赖),端点权威由父进程 pin 后
  // 经 env 传下;这里显式认领,让「身份只建立在已 pin 端点上」在 daemon 侧同样成立。
  pinEndpointFromEnvironment();
  const identity = currentDaemonIdentity();
  const instance = { pid: process.pid, birth: processBirthIdentity(process.pid) };
  let phase: DaemonPhase = 'starting';

  const attached = new AttachmentRegistry<Target, WebSocket, CloseEvent>({
    attach: attachInject,
    connect: target => pageWs(target, undefined, MONITOR_WEBSOCKET_CONNECT_TIMEOUT_MS),
    targetId: target => target.id,
  });

  // 看门狗:浏览器被关掉后 /json/list 会持续探测失败。连续 WATCHDOG_POLLS 次(约 5s)
  // 失败 → 自动退出,不留孤儿 daemon(下次 open/ensure/logs 会自动重新拉起)。
  let deadPolls = 0;
  const WATCHDOG_POLLS = 10;
  async function sync(tolerateBrowserFailure = true): Promise<void> {
    let list: Target[];
    try {
      list = await listTargets(MONITOR_TARGET_LIST_TIMEOUT_MS);
    } catch (cause) {
      if (!tolerateBrowserFailure) throw cause;
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
    await attached.ensureAll(list, MONITOR_ATTACH_BATCH_SIZE);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${LOGS_PORT}`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (url.pathname === '/health') {
      res.end(JSON.stringify(daemonHealthPayloads(identity, instance, phase, attached.size).legacy));
      return;
    }
    if (url.pathname === '/health/v1') {
      res.end(JSON.stringify(daemonHealthPayloads(identity, instance, phase, attached.size).versioned));
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
    rollbackBind: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      }),
    rollbackPid: () => {
      try {
        if (readFileSync(pidFilePath(), 'utf8').trim() === String(process.pid)) unlinkSync(pidFilePath());
      } catch {}
    },
    syncInitialTargets: () => sync(false),
  });
  phase = 'ready';
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
  // 调用方(api.logs)必须已 ensureBrowser 把端点 pin 到权威 port,否则这里会以未 pin 的猜测端口判定
  // daemon 身份。诊断由 runMonitorAutostart 内部以稳定前缀写 stderr,此处 catch 仅防 unhandled rejection。
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
