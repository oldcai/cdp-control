/**
 * monitor-inject.ts — 页面监控注入逻辑(hook console/onerror/unhandledrejection → window.__cdpLogs)。
 * 存**活的嵌套对象**(读时再结构化序列化)。window.__cdpMon 哨兵保证幂等。
 * 被 monitor.ts 入口(addScriptToEvaluateOnNewDocument)与 read.ts 入口(读日志前确保注入)复用。
 */
export interface BrowserLogEntry {
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

type MonitorWindow = Window & { __cdpMon?: boolean; __cdpLogs?: BrowserLogEntry[] };

const monitorWindow = window as MonitorWindow;

function stackOf(value: unknown): string | undefined {
  if (value instanceof Error) return value.stack;
  if (typeof value === 'object' && value !== null && 'stack' in value && typeof value.stack === 'string') {
    return value.stack;
  }
  return undefined;
}

export function installMonitor(): void {
  if (monitorWindow.__cdpMon) return;
  monitorWindow.__cdpMon = true;
  const logs = (monitorWindow.__cdpLogs ??= []);
  const CAP = 2000;
  function push(e: BrowserLogEntry) {
    logs.push(e);
    if (logs.length > CAP) logs.splice(0, logs.length - CAP);
  }
  function stack() {
    try {
      return new Error().stack;
    } catch {
      return '';
    }
  }
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const k of levels) {
    const orig = console[k];
    if (typeof orig !== 'function') continue;
    console[k] = (...args: unknown[]) => {
      push({ ts: Date.now(), type: 'console', level: k, args, stack: stack() });
      return orig.apply(console, args);
    };
  }
  window.addEventListener('error', function (ev) {
    push({
      ts: Date.now(),
      type: 'exception',
      level: 'error',
      message: ev.message || '',
      source: ev.filename || '',
      line: ev.lineno,
      col: ev.colno,
      reason: ev.error,
      stack: stackOf(ev.error) || ev.message || '',
    });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    const r = ev.reason;
    push({ ts: Date.now(), type: 'rejection', level: 'error', reason: r, stack: stackOf(r) || stack() });
  });
}

export function browserLogs(): BrowserLogEntry[] {
  return monitorWindow.__cdpLogs ?? [];
}
