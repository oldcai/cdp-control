/**
 * probe.ts — 只读探测原语(注入侧,浏览器)。随 view 注入装成页面全局 `window.__cdpProbe`,
 * 供 recipe 的 eval 直接调用,替代每个规则手抄 refOf/text 样板(P1/P6)。
 *
 * 硬约束:**只查不注册**——refOf 只反查已建树的 __cdpRefs,绝不按需注册(否则平移全局 ref 号、
 * 断 parentRef 自愈链,现网明令禁止)。依赖 __cdpRefs 已由 view 的 buildView 建好;recipe 约定
 * 先 `cdp.view` 建树再 eval,故探针随 view 注入即保证可用(不依赖 daemon)。
 *
 * 与抽取/呈现分层一致:探针是**浏览器侧 DOM 读**,归一化/呈现仍归 Node 侧 `_lib.js`。
 */
import { findRoot, entryEl, type RefEntry } from './find-root.ts';

/** 元素 → 已建树 ref(未建树 → null,绝不注册)。 */
export function refOf(el: Element | null | undefined): number | null {
  const refs = (globalThis as any).__cdpRefs as any[] | undefined;
  if (!el || !refs || !refs.length) return null;
  for (let i = 0; i < refs.length; i++) {
    const entry = refs[i];
    const e = entry && (entry.el ?? entry); // 兼容 {el,parentRef} 与裸 Element 两种登记形态
    if (e === el) return i;
  }
  return null;
}

/** 已登记元素 → ref 的索引(同一元素多次登记取最小号,与 refOf 一致)。只读。 */
export function refIndex(): Map<Element, number> {
  const refs = (globalThis as unknown as { __cdpRefs?: RefEntry[] }).__cdpRefs ?? [];
  const index = new Map<Element, number>();
  refs.forEach((entry, i) => {
    const el = entryEl(entry);
    if (el && !index.has(el)) index.set(el, i);
  });
  return index;
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

/** 幂等装探针:页面全局已存在则跳过(SPA/刷新由 view 每次重建时补装)。 */
export function installProbe(): void {
  if ((globalThis as any).__cdpProbe) return;
  (globalThis as any).__cdpProbe = { refOf, refOfSelector, text };
}
