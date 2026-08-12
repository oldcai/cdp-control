/**
 * ref.ts — locate 注入入口:按 view 的 ref 序号反查稳定 CSS selector。
 * ref 是会话句柄(存 window.__cdpRefs),页面刷新后失效;此命令把 ref 翻译成
 * 刷新后仍可用的 CSS selector,供 view --selector-file 复用。
 * 可选 --ancestor 向上爬 N 层父级,把"内容叶子的 ref"抬升到"语义区域容器"。
 *
 * shadow DOM:目标在 shadow 内时,标准 CSS selector 在 document 上查不到(querySelector 返 null)。
 * 此入口检测 shadow 并额外生成 shadowChain(hostSel >>> innerSel >>> ...),findRoot 能解析该链穿透。
 * 普通 selector 字段仍返回(对 shadow 内元素只是 host 锚定或不可用),shadowChain 才是可用链。
 */
import { setResult } from './lib/result';
import { refElement, climbAncestors, inShadow, buildShadowChain, outermostHost } from './lib/find-root';
import { genSel } from './lib/genSel';
import { ownElText } from './lib/view-core';
import { notFoundResult, type OperableArg } from './lib/find';
import type { LocateArgs } from './lib/arg';

declare const __CDP_ARG__: LocateArgs;

(() => {
  const base = refElement(__CDP_ARG__.ref);
  if (!base) return setResult(notFoundResult({ ref: __CDP_ARG__.ref } as OperableArg));
  const el = climbAncestors(base, __CDP_ARG__.ancestor || 0);
  if (!el)
    return setResult({ ok: false, err: `ref=${__CDP_ARG__.ref} 向上爬 ${__CDP_ARG__.ancestor || 0} 层后无元素` });
  // 用元素**自身直接文本**(只取直接子文本节点),不混入子树文本(避免按钮显示子树里作者名等误导)。
  const text = ownElText(el).slice(0, 80);
  const shadow = inShadow(el);
  // shadow 内元素:标准 selector 在 document 上查不到。返回其最外层 host 的 selector(至少指向容器),
  // 真正可用的穿透链在 shadowChain。普通 light 元素:genSel 正常。
  const selector = shadow ? genSel(outermostHost(el)) : genSel(el);
  const shadowChain = shadow ? buildShadowChain(el) : null;
  return setResult({ ok: true, tag: el.tagName.toLowerCase(), text, selector, shadow, shadowChain });
})();
