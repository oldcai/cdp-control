/**
 * read-content.ts — 展开再读的容器定位注入入口(同步):按 `container` selector 重查正文容器,
 * 通过统一 helper 登记进 __cdpRefs(旧元素复用、重渲染的新元素追加),返回 ref 供 Node 侧 article 取全文。
 *
 * **为何纯同步、不含点击/等待**:展开点击若在本 eval 内再 `await setTimeout`,会与
 * Runtime.evaluate 的 awaitPromise 交互而卡死(实测 zhihu 展开点击)。故点击(同步 eval 先返回)、
 * Node 侧 sleep、再本入口重查,三者分开——各自同步、互不阻塞。
 *
 * 展开重渲染替换容器 → 每次重查按 selector 命中新元素,首次见到才追加(既有号不变,同 find-entry)。
 * 折叠判定(要不要展开)仍由 recipe 决定,入口只保证"给定容器 selector 拿到它的稳定 ref"。
 */
import { setResult } from './lib/result';
import { findRoot, registerRef } from './lib/find-root';
import type { ReadContentArgs } from './lib/arg';

declare const __CDP_ARG__: ReadContentArgs;

(() => {
  const el = findRoot(__CDP_ARG__.container);
  if (!el) return setResult({ ok: false, err: `read: 未找到容器: ${__CDP_ARG__.container}` });
  // 容器 ref:已在树则复用;展开重渲染的新元素首次见到时才在表尾追加(同 find-entry)。
  const ref = registerRef(el);
  return setResult({ ok: true, ref, tag: el.tagName.toLowerCase() });
})();
