/**
 * goal-tree.ts — find --goal 的全页紧凑树(注入到浏览器页面执行)。
 *
 * 与整页 view 的差别,都是为了这棵树要发往第三方、而 agent 手里还握着旧 ref:
 * - **绝不清 __cdpRefs**:已登记元素复用原 ref,新元素才追加。反复调用不膨胀、不平移。
 * - **输入内容不进树**:value、textarea 文本、contenteditable 子树都不采,不出页面。
 * - **不折叠**:按意图找元素要看全页,fold 规则只为压缩给 agent 读的树。
 * 与 view 一样在页面首次整页感知时滚动触发懒加载,否则首屏外的元素会被误判成"没有"。
 */
import { setResult } from './lib/result';
import { markText, formatView } from './lib/view-format';
import { buildView } from './lib/view-core';
import { scrollToLoad, SCROLL_WAIT_MS } from './lib/scroll-load';
import type { GoalTreeArgs } from './lib/arg';

declare const __CDP_ARG__: GoalTreeArgs;

interface PageGlobals { __cdpRefs?: unknown[]; __cdpFullViewDone?: boolean }

setResult((async () => {
  if (!document.body) return { ok: false, err: '页面还没有 body,等加载后重试' };
  const page = globalThis as unknown as PageGlobals;
  page.__cdpRefs ??= [];
  if (!page.__cdpFullViewDone) {
    page.__cdpFullViewDone = true;
    await scrollToLoad();
    await new Promise(r => setTimeout(r, SCROLL_WAIT_MS));
  }
  const v = buildView(document.body, {
    viewport: true, ignoreLinks: __CDP_ARG__.ignoreLinks, ignoreFolds: true, reuseRefs: true, redactInputs: true,
  });
  markText(v);
  return { ok: true, lines: formatView(v) };
})());
