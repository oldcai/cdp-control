/**
 * read.ts — 读控制台日志入口。前置注入监控脚本(幂等),再结构化序列化 window.__cdpLogs。
 * 序列化保留普通对象/数组的**嵌套结构**,循环引用 → [循环]、DOM 节点 → <DIV#id>、
 * Error → {name,message}、深度/键数封顶。level 过滤与 since 时间戳在页面侧完成。
 */
import { setResult } from './lib/result';
import { installMonitor } from './lib/monitor-inject';
import type { ReadArgs } from './lib/arg';

declare const __CDP_ARG__: ReadArgs;

(() => {
  installMonitor();
  const arr = (window as any).__cdpLogs || [];
  const since = __CDP_ARG__.since || 0;
  const filter = __CDP_ARG__.level
    ? (e: any) => __CDP_ARG__.level!.indexOf(e.level) !== -1
    : (e: any) => e.type !== 'browser';

  function makeStruct() {
    const seen = new WeakSet();
    return function struct(v: any, d: number): any {
      if (v === null) return null;
      const t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') return v;
      if (t === 'undefined') return undefined;
      if (t === 'function' || t === 'symbol' || t === 'bigint') return String(v);
      if (t !== 'object') return String(v);
      if (d > 8) return '[深]';
      if (v instanceof Error) return { name: v.name, message: v.message };
      if (Array.isArray(v)) {
        const a: any[] = [];
        for (let i = 0; i < v.length && i < 50; i++) a.push(struct(v[i], d + 1));
        return a;
      }
      if (v.nodeType) return '<' + (v.nodeName || '?') + (v.id ? '#' + v.id : '') + '>';
      if (seen.has(v)) return '[循环]';
      seen.add(v);
      const o: any = {};
      let n = 0;
      for (const k in v) {
        if (n++ >= 30) {
          o['...'] = '(+more)';
          break;
        }
        try {
          o[k] = struct(v[k], d + 1);
        } catch {
          o[k] = String(v[k]);
        }
      }
      return o;
    };
  }

  const out = arr
    .filter((e: any) => e.ts >= since && filter(e))
    .map((e: any) => {
      const struct = makeStruct();
      const o: any = { ts: e.ts, type: e.type, level: e.level, args: (e.args || []).map((a: any) => struct(a, 0)) };
      if (e.stack) o.stack = e.stack;
      if (e.message) o.message = e.message;
      if (e.source) o.source = e.source;
      if (e.line != null) o.line = e.line;
      if (e.col != null) o.col = e.col;
      if (e.reason !== undefined) o.reason = struct(e.reason, 0);
      return o;
    });
  return setResult(out);
})();
