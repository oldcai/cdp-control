/**
 * find.ts — 注入侧操作目标解析(click/fill/focus/hover 共享)+ ref 失效自愈。
 * 优先按 ref(view 登记的全局真实元素引用,可穿透 shadow DOM);否则按 CSS selector。
 * ref 的取法:window.__cdpRefs 是 view 遍历时登记的引用数组,index 即 view 输出的 [ref=i]。
 * --ancestor:按 ref 定位后向上爬 N 层父级再操作(把内容叶子抬到语义区域容器)。
 */
import { climbAncestors, classifyRef, entryEl, entryParent, getRefs, refElement } from './find-root';
import { buildView } from './view-core';
import { markText, formatView } from './view-format';

export interface OperableArg { sel?: string; ref?: number; ancestor?: number }

/** 解析操作目标:ref 命中返回登记的真实元素(可选再爬 ancestor 层);否则 document.querySelector(sel)。找不到返回 null。 */
export function findTarget(arg: OperableArg): Element | null {
  if (arg.ref != null) {
    return climbAncestors(refElement(arg.ref), arg.ancestor || 0);
  }
  return arg.sel ? document.querySelector(arg.sel) : null;
}

/** 目标描述(错误/日志用):ref=12(或 ref=12↑3)或 sel=<selector>。 */
export function targetLabel(arg: OperableArg): string {
  if (arg.ref != null) return 'ref=' + arg.ref + (arg.ancestor ? `↑${arg.ancestor}` : '');
  return (arg.sel ?? '');
}

/** 找不到目标时的结果:ref 失效→自愈(沿 parentRef 跳表找最近存活祖先,局部 view 给 agent 用新 ref 重试);
 * selector 未命中→普通错误。recovered 三态见 recoverRef。 */
export function notFoundResult(arg: OperableArg): any {
  if (arg.ref != null) return { ok: false, refInvalid: true, recovered: recoverRef(arg.ref) };
  return { ok: false, err: '未找到: ' + targetLabel(arg) };
}

/** recoverRef 返回值三态(供 CLI 区分文案):
 *  - {never:true, maxRef, msg}:ref 越界或从未登记(agent 打错号),不走跳表自愈。
 *  - {rootRef, lines}:跳表找到仍 connected 的最近祖先,局部 view 已生成,agent 用新 ref 重试。
 *  - null:登记过但整条祖先链都已 detached(页面整体刷新/重建),提示重新 view。
 * maxRef 恒带(当前最大 ref 号,便于 agent 核对)。 */
export type Recovered = { never: true; maxRef: number; msg: string }
  | { rootRef: number; lines: string[] } | null;

/** ref 失效自愈:从未存在→never 态;曾存在但 detached→沿 parentRef 跳表找最近存活祖先,
 * 以它为根做局部 view(增量 ref,不重置全局表——复用反馈机制,原整页 ref 不受影响),
 * 返回 {rootRef, lines} 供 agent 用新 ref 重试。整链都失效(页面刷新)返回 null。
 * 判定逻辑(纯)在 find-root.ts 的 classifyRef,可单测;DOM 部分(buildView)在此。 */
export function recoverRef(ref: number): Recovered {
  const cls = classifyRef(ref);
  if (cls.kind === 'none') return null;
  if (cls.kind === 'never') {
    return { never: true, maxRef: cls.maxRef, msg: `ref=${ref} 从未存在(当前最大 ref=${cls.maxRef}),检查 ref 号` };
  }
  const refs = getRefs()!;
  let cur: number | null = cls.start;
  let guard = 0;
  while (cur != null && guard++ < 9999) {
    const el = entryEl(refs[cur]);
    if (el instanceof Element && el.isConnected) {
      const t = buildView(el, { viewport: true });
      markText(t);
      return { rootRef: cur, lines: formatView(t) };
    }
    cur = entryParent(refs[cur]);
  }
  return null;
}
