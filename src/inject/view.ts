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
import { notFoundResult, type OperableArg } from './lib/find';
import { installProbe } from './lib/probe';
import type { ViewArgs } from './lib/arg';

declare const __CDP_ARG__: ViewArgs;

// 整段包成 async(通过 setResult 传 promise,footer await):支持 --scroll-to-load 先异步滚动再建视图。
setResult((async () => {
  // 装只读探针 __cdpProbe(refOf/refOfSelector/text):recipe 约定先 view 建树再 eval,故随 view
  // 注入即保证可用;探针只查已建树 __cdpRefs、绝不注册；每次刷新实现以兼容旧页面残留。
  installProbe();
  // 锚点互斥:ref 优先(读上一次 view 登记的 __cdpRefs),
  // 其次 selector,缺省 body。--ancestor 为统一爬父修饰符,对任一锚点生效。
  let root: Element | null;
  if (__CDP_ARG__.ref != null) {
    root = climbAncestors(refElement(__CDP_ARG__.ref), __CDP_ARG__.ancestor);
    if (!root || root.nodeType !== 1) return setResult(notFoundResult({ ref: __CDP_ARG__.ref } as OperableArg));
  } else {
    root = climbAncestors(findRoot(__CDP_ARG__.selector), __CDP_ARG__.ancestor);
    if (!root || root.nodeType !== 1) return setResult({ ok: false, err: '未找到匹配的根节点(selector 未命中)' });
  }
  // 全局 ref 登记表不清空：整页/局部 view 都复用旧元素号码，新元素只追加，已印发 ref 不换指向。
  // --scroll-to-load:滚动触发懒加载(评论区等首屏外的内容),再建视图。三种模式(默认行为不变):
  // (1) 默认(无 scrollPages/scrollTo):向下/向上各一屏后回原位,固定距离触发当前位置上下懒加载。
  //     刻意不大范围滚多屏再回顶——那会拉飞视口、让 agent 在已展开长内容页时丢失当前位置(曾踩坑)。
  // (2) scrollTo:先滚到匹配该 selector 的元素(B站评论区容器等),停下让懒加载触发。命中不到优雅降级(跳过)。
  // (3) scrollPages:循环向下滚 N 屏(每屏 innerHeight),边滚边检测 scrollHeight 增长,连续 2 次不增长提前停。
  //     适用于无限流(持续滚+等加载);注意:知乎等站点的"用户主动滚动"反爬即便分步滚也可能触发不了,
  //     这是站点反爬不是工具 bug。scrollTo 与 scrollPages 可并用(先滚到元素,再循环滚 N 屏)。
  async function scrollToLoad() {
    const pause = 150;
    const vh = innerHeight || document.documentElement.clientHeight || 800;
    const h0 = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const start = Math.min(window.scrollY, Math.max(0, h0() - vh));

    // (2) 先滚到指定 selector 元素(若有)。命中不到跳过、不抛错。
    if (__CDP_ARG__.scrollTo) {
      try {
        const el = document.querySelector(__CDP_ARG__.scrollTo);
        if (el) {
          (el as Element).scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'start' });
          await new Promise(r => setTimeout(r, pause));
        }
      } catch { /* selector 命中不到/scrollIntoView 异常:优雅降级,正常建视图 */ }
    }

    if (__CDP_ARG__.scrollPages && __CDP_ARG__.scrollPages > 0) {
      // (3) 循环向下滚 N 屏,边滚边检测 scrollHeight 增长,连续 2 次不增长提前停。上限保护防死循环。
      const max = Math.min(__CDP_ARG__.scrollPages, 50);
      let stagnant = 0;
      let lastH = h0();
      for (let i = 0; i < max; i++) {
        window.scrollTo(0, window.scrollY + vh);
        await new Promise(r => setTimeout(r, pause));
        const now = h0();
        if (now > lastH) stagnant = 0; else stagnant++;
        lastH = now;
        if (stagnant >= 2) break; // 连续 2 次不增长:已到底/无新内容
      }
      window.scrollTo(0, start); await new Promise(r => setTimeout(r, pause)); // 回原位
    } else if (!__CDP_ARG__.scrollTo) {
      // (1) 默认 ±1 屏回弹(无 scrollTo 时——给了 scrollTo 已滚到位,不再回弹)
      const h = h0();
      const down = Math.min(start + vh, Math.max(0, h - vh));
      window.scrollTo(0, down); await new Promise(r => setTimeout(r, pause));
      window.scrollTo(0, Math.max(0, down - vh)); await new Promise(r => setTimeout(r, pause));
      window.scrollTo(0, start); await new Promise(r => setTimeout(r, pause));
    }
  }
  // 默认滚动加载:整页完整 view(无 ref/selector/visibleOnly、未显式给任何滚动参数)时,
  // 页面首次整页感知自动 scroll-to-load 触发懒加载(评论区等首屏外内容),抓全再建树——fetch 也走这里。
  // 页面级标志 __cdpFullViewDone:同页面刷新前只滚一次,后续整页 view 不再默认滚(除非显式 --scroll-to-load)。
  const isFullView = __CDP_ARG__.ref == null && !__CDP_ARG__.selector && !__CDP_ARG__.visibleOnly;
  const hasExplicitScroll = __CDP_ARG__.scrollToLoad || __CDP_ARG__.scrollPages != null || !!__CDP_ARG__.scrollTo;
  if (__CDP_ARG__.scrollToLoad || (isFullView && !hasExplicitScroll && !(globalThis as any).__cdpFullViewDone)) {
    if (isFullView && !hasExplicitScroll) (globalThis as any).__cdpFullViewDone = true; // 先置位防并发重滚
    await scrollToLoad();
    // 滚动触发懒加载后等待内容渲染(scrollWait 默认 1000ms;显式传可调),否则滚动完立即建树,新回答/评论区还没加载出来。
    const wait = __CDP_ARG__.scrollWait != null ? __CDP_ARG__.scrollWait : 1000;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  const visibleOnly = !!__CDP_ARG__.visibleOnly;
  const v = buildView(root, { visibleOnly, viewport: true, folds: __CDP_ARG__.folds, ignoreLinks: __CDP_ARG__.ignoreLinks, maxLen: __CDP_ARG__.maxLen });
  markText(v);
  return setResult({ ok: true, lines: formatView(v, __CDP_ARG__.maxLen) });
})());
