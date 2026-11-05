/**
 * view.ts — 结构视图入口(注入到浏览器页面执行)。
 * 精简整页 body(或指定区域)为"文本 + 结构"紧凑树。丢垃圾标签、折叠纯包装节点、
 * 穿透 shadow DOM、合并交互/标题叶。不做可见性判定——整页结构一次给全。
 *
 * 契约:读取 __CDP_ARG__.rootExpr(解析建视图根元素的 JS 表达式串),把结果写入 setResult。
 * 输出为带缩进文本行数组(标签 + 引用文本),无 [看]/[架]/[X] 状态前缀。
 * 建视图复用 lib/view-core 的 buildView;带 ref 的节点额外标在视区(view,输出 [ref=i, visible])。
 */
import { setResult } from './lib/result';
import { markText, formatView } from './lib/view-format';
import { buildView } from './lib/view-core';
import { findRoot, refElement, climbAncestors } from './lib/find-root';
import { installProbe } from './lib/probe';
import { scrollToLoad, SCROLL_WAIT_MS } from './lib/scroll-load';
import type { ViewArgs } from './lib/arg';

declare const __CDP_ARG__: ViewArgs;

// 整段包成 async(通过 setResult 传 promise,footer await):支持 --scroll-to-load 先异步滚动再建视图。
setResult((async () => {
  // 装只读探针 __cdpProbe(refOf/refOfSelector/text):recipe 约定先 view 建树再 eval,故随 view
  // 注入即保证可用;探针只查已建树 __cdpRefs、绝不注册。幂等(页面全局已存在则跳过)。
  installProbe();
  // 锚点互斥:ref 优先(读上一次 view 登记的 __cdpRefs,须在下方清空表之前解析),
  // 其次 selector,缺省 body。--ancestor 为统一爬父修饰符,对任一锚点生效。
  let root: Element | null;
  if (__CDP_ARG__.ref != null) {
    root = climbAncestors(refElement(__CDP_ARG__.ref), __CDP_ARG__.ancestor);
    if (!root || root.nodeType !== 1) return setResult({ ok: false, err: `ref=${__CDP_ARG__.ref} 无效或已失效(ref 是会话句柄,页面刷新后失效;需先重新 view 拿到新 ref)` });
  } else {
    root = climbAncestors(findRoot(__CDP_ARG__.selector), __CDP_ARG__.ancestor);
    if (!root || root.nodeType !== 1) return setResult({ ok: false, err: '未找到匹配的根节点(selector 未命中)' });
  }
  // 全局 ref 登记表:整页 view(ref/selector 均缺省)才重置,从 0 重新编号,index 即输出里的 [ref=i];
  // 局部 view(<ref>/<selector>)只追加(增量号),保住整页已登记的其他 ref 不被顶掉(view 151 后再 view 152 仍有效)。
  const resetRefs = __CDP_ARG__.ref == null && !__CDP_ARG__.selector;
  if (resetRefs) (globalThis as any).__cdpRefs = [];
  // 默认滚动加载:整页完整 view(无 ref/selector/visibleOnly、未显式给任何滚动参数)时,
  // 页面首次整页感知自动 scroll-to-load 触发懒加载(评论区等首屏外内容),抓全再建树——fetch 也走这里。
  // 页面级标志 __cdpFullViewDone:同页面刷新前只滚一次,后续整页 view 不再默认滚(除非显式 --scroll-to-load)。
  const isFullView = __CDP_ARG__.ref == null && !__CDP_ARG__.selector && !__CDP_ARG__.visibleOnly;
  const hasExplicitScroll = __CDP_ARG__.scrollToLoad || __CDP_ARG__.scrollPages != null || !!__CDP_ARG__.scrollTo;
  if (__CDP_ARG__.scrollToLoad || (isFullView && !hasExplicitScroll && !(globalThis as any).__cdpFullViewDone)) {
    if (isFullView && !hasExplicitScroll) (globalThis as any).__cdpFullViewDone = true; // 先置位防并发重滚
    await scrollToLoad(__CDP_ARG__);
    // 滚动触发懒加载后等待内容渲染(scrollWait 默认 1000ms;显式传可调),否则滚动完立即建树,新回答/评论区还没加载出来。
    const wait = __CDP_ARG__.scrollWait != null ? __CDP_ARG__.scrollWait : SCROLL_WAIT_MS;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  const visibleOnly = !!__CDP_ARG__.visibleOnly;
  const v = buildView(root, { visibleOnly, viewport: true, folds: __CDP_ARG__.folds, ignoreLinks: __CDP_ARG__.ignoreLinks, maxLen: __CDP_ARG__.maxLen });
  markText(v);
  return setResult({ ok: true, lines: formatView(v, __CDP_ARG__.maxLen) });
})());
