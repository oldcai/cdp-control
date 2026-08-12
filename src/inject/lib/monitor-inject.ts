/**
 * monitor-inject.ts — 页面监控注入逻辑(hook console/onerror/unhandledrejection → window.__cdpLogs)。
 * 存**活的嵌套对象**(读时再结构化序列化)。window.__cdpMon 哨兵保证幂等。
 * 被 monitor.ts 入口(addScriptToEvaluateOnNewDocument)与 read.ts 入口(读日志前确保注入)复用。
 */
export function installMonitor(): void {
  if ((window as any).__cdpMon) return;
  (window as any).__cdpMon = true;
  const logs: any[] = ((window as any).__cdpLogs = (window as any).__cdpLogs || []);
  const CAP = 2000;
  function push(e: any) {
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
  const lv: Record<string, number> = { log: 1, info: 1, warn: 1, error: 1, debug: 1 };
  for (const k in lv) {
    const orig = (console as any)[k];
    if (typeof orig !== 'function') continue;
    (function (name, base) {
      (console as any)[name] = function (...args: any[]) {
        push({ ts: Date.now(), type: 'console', level: name, args, stack: stack() });
        return base.apply(console, args);
      };
    })(k, orig);
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
      stack: (ev.error && (ev.error as any).stack) || ev.message || '',
    });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    const r = ev.reason;
    push({ ts: Date.now(), type: 'rejection', level: 'error', reason: r, stack: (r && (r as any).stack) || stack() });
  });
}
