/**
 * probe.ts — 只读探测原语(注入侧,浏览器)。随 view 注入装成页面全局 `window.__cdpProbe`,
 * 供 recipe 的 eval 直接调用,替代每个规则手抄 refOf/text 样板(P1/P6)。
 *
 * 硬约束:**只查不注册**——refOf 只经 WeakMap 反查已建树的 __cdpRefs,绝不按需注册(否则污染
 * 全局编号与 parentRef 自愈链)。依赖 __cdpRefs 已由 view 的 buildView 建好;recipe 约定
 * 先 `cdp.view` 建树再 eval,故探针随 view 注入即保证可用(不依赖 daemon)。
 *
 * 与抽取/呈现分层一致:探针是**浏览器侧 DOM 读**,归一化/呈现仍归 Node 侧 `_lib.js`。
 */
import { findRoot, lookupRef } from './find-root.ts';

type ProbeGlobals = typeof globalThis & {
  __cdpProbe?: { refOf: typeof refOf; refOfSelector: typeof refOfSelector; text: typeof text };
};

/** 元素 → 已建树 ref(未建树 → null,绝不注册)。 */
export function refOf(el: Element | null | undefined): number | null {
  return lookupRef(el);
}

/** 按 selector 查已建树元素的 ref(穿透 shadow)。未命中元素 → {ref:null,el:null};元素在但未建树 → {ref:null,el}。 */
export function refOfSelector(sel: string): { ref: number | null; el: Element | null } {
  const el = findRoot(sel);
  return { el, ref: el ? refOf(el) : null };
}

/** 元素纯文本(缺省空串)。 */
export function text(el: Element | null | undefined): string {
  return el ? el.textContent || '' : '';
}

/** 每次 view 刷新探针实现；新 document 自然得到新对象，旧页面也可从旧版探针热升级。 */
export function installProbe(): void {
  (globalThis as ProbeGlobals).__cdpProbe = { refOf, refOfSelector, text };
}
