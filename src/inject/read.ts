/**
 * read.ts — 读控制台日志入口。前置注入监控脚本(幂等),再结构化序列化 window.__cdpLogs。
 * 序列化保留普通对象/数组的**嵌套结构**,循环引用 → [循环]、DOM 节点 → <DIV#id>、
 * Error → {name,message}、深度/键数封顶。level 过滤与 since 时间戳在页面侧完成。
 */
import { setResult } from './lib/result';
import { browserLogs, installMonitor, type BrowserLogEntry } from './lib/monitor-inject';
import type { ReadArgs } from './lib/arg';

declare const __CDP_ARG__: ReadArgs;

(() => {
  installMonitor();
  const arr = browserLogs();
  const since = __CDP_ARG__.since || 0;
  const filter = __CDP_ARG__.level
    ? (entry: BrowserLogEntry) => __CDP_ARG__.level?.includes(entry.level) === true
    : (entry: BrowserLogEntry) => entry.type !== 'browser';

  function makeStruct() {
    const seen = new WeakSet<object>();
    return function struct(v: unknown, d: number): unknown {
      if (v === null) return null;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
      if (typeof v === 'undefined') return undefined;
      if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return String(v);
      if (typeof v !== 'object') return String(v);
      if (d > 8) return '[深]';
      if (v instanceof Error) return { name: v.name, message: v.message };
      if (Array.isArray(v)) {
        const a: unknown[] = [];
        for (let i = 0; i < v.length && i < 50; i++) a.push(struct(v[i], d + 1));
        return a;
      }
      const nodeType = Reflect.get(v, 'nodeType');
      const nodeName = Reflect.get(v, 'nodeName');
      if ((v instanceof Node || typeof nodeType === 'number') && typeof nodeName === 'string') {
        const rawId = Reflect.get(v, 'id');
        const id = typeof rawId === 'string' && rawId ? '#' + rawId : '';
        return '<' + (nodeName || '?') + id + '>';
      }
      if (seen.has(v)) return '[循环]';
      seen.add(v);
      const o: Record<string, unknown> = {};
      let n = 0;
      for (const k in v) {
        if (n++ >= 30) {
          o['...'] = '(+more)';
          break;
        }
        try {
          o[k] = struct(Reflect.get(v, k), d + 1);
        } catch {
          o[k] = String(Reflect.get(v, k));
        }
      }
      return o;
    };
  }

  const out = arr
    .filter(entry => entry.ts >= since && filter(entry))
    .map(entry => {
      const struct = makeStruct();
      const o: Record<string, unknown> = {
        ts: entry.ts,
        type: entry.type,
        level: entry.level,
        args: (entry.args || []).map(value => struct(value, 0)),
      };
      if (entry.stack) o.stack = entry.stack;
      if (entry.message) o.message = entry.message;
      if (entry.source) o.source = entry.source;
      if (entry.line != null) o.line = entry.line;
      if (entry.col != null) o.col = entry.col;
      if (entry.reason !== undefined) o.reason = struct(entry.reason, 0);
      return o;
    });
  return setResult(out);
})();
