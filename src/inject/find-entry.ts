/**
 * find-entry.ts — find 命令注入入口(类 uBlock `:has-text()` 思想,但语义更贴合 agent 找元素)。
 *
 * agent 的痛点:整页 view 输出严禁 grep(SKILL 铁律),重新定位某个文本元素又不该重读整棵树。
 * 想重新定位某个文本元素(如"28 条评论"按钮)时,只能整页 view 再肉眼找——既费 token 又违规。
 * find 弥补:直接按文本/selector 找元素,登记新 ref 返回,不必整页重 view。
 *
 * 两种匹配:
 *   1. --text <关键词>:在整页(穿透 shadow)DFS,命中"**元素自身直接文本**(ownElText,只取直接
 *      子文本节点)含关键词"的元素。注意不是子树文本(subtreeText)——后者会让最外层容器先命中
 *      (body 几乎含所有文本),agent 拿到的是祖先 div 而非"首页"那个 a 标签。用自身文本才能命中
 *      最具体的有文本元素(按钮/链接/文本节点)。uBlock `:has-text()` 是子树匹配(用于折叠容器),
 *      这里反过来要找具体元素,故用自身文本。
 *   2. --selector <css>:document.querySelector(支持 `>>>` shadow 链,复用 findRoot)。
 *      配 --all 改用 querySelectorAll(支持 `>>>` 链,见 findRootAll),逐个登记。
 *
 * 命中元素通过统一 helper 登记进 __cdpRefs(已登记复用、首次见到追加),拿 ref 号;buildView 该元素
 * 取根行输出(把根节点 ref 标成 push 拿到的号,formatView 自动输出 [ref=N])。
 * --text + --all:收集全部命中并各自登记;否则首个。
 * --ancestor:命中后向上爬 N 层到容器(把内容叶子抬到区域容器,与 view/locate 一致)。
 *
 * 性能 sanity:**不设硬深度上限**(现代 SPA 动辄 20+ 层 div 嵌套,硬深度会漏深层元素——知乎
 * `html>body>div×12>span×2>button` 就 15 层)。改用访问节点数上限(MAX_VISIT)防极端爆炸,
 * 配 visited Set 防环 / 防 shadow 重入。核心遍历逻辑抽在 lib/find-search.ts(无 DOM 依赖可单测)。
 */
import { setResult } from './lib/result';
import { findRoot, findRootAll, climbAncestors, registerRef } from './lib/find-root';
import { childrenOf, ownElText } from './lib/view-core';
import { buildView } from './lib/view-core';
import { markText, formatView } from './lib/view-format';
import { searchByText, DEFAULT_MAX_VISIT } from './lib/find-search';
import type { FindCmdArgs } from './lib/arg';

declare const __CDP_ARG__: FindCmdArgs;

const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'PATH', 'BR']);

/** 取命中元素的 line(formatView 根行,标上分配的 ref 号)。 */
function lineOf(el: Element, ref: number): string {
  const v = buildView(el, { viewport: true });
  v.ref = ref; // 根节点标上分配的 ref,formatView 输出 [ref=N, visible?]
  markText(v);
  const lines = formatView(v);
  return lines[0] || `${el.tagName.toLowerCase()} [ref=${ref}]`;
}

/** DOM 适配器 + 关键词,跑纯逻辑 searchByText 收集文本命中元素。 */
function searchText(root: Element, needle: string): Element[] {
  return searchByText<Element>(root, needle, {
    // childrenOf 返回 (Element|ShadowRoot)[],但 shadowRoot.children 元素都是 Element;
    // 取 Element[] 即可(ShadowRoot 自身无标签、不参与匹配,其子在 childrenOf 已展平)。
    getChildren: (el) => childrenOf(el).filter((c): c is Element => c instanceof Element),
    getText: (el) => ownElText(el),
    isElement: (n) => n instanceof Element,
    tagOf: (n) => (n instanceof Element ? n.tagName : ''),
  }, { dropTags: DROP_TAGS, maxVisit: DEFAULT_MAX_VISIT });
}

(() => {
  const a = __CDP_ARG__;
  if (!a.text && !a.selector) return setResult({ ok: false, err: '需提供 --text 或 --selector' });

  let hits: Element[] = [];
  if (a.selector) {
    // --all 时用 querySelectorAll 收全部(支持 >>> shadow 链);否则首个。
    hits = a.all ? findRootAll(a.selector) : (findRoot(a.selector) ? [findRoot(a.selector)!] : []);
  } else {
    hits = searchText(document.body, a.text!);
  }
  if (!hits.length) {
    return setResult({ ok: false, err: a.selector ? `selector 未命中: ${a.selector}` : `未找到含文本的元素: "${a.text}"` });
  }

  // --all 收集全部;否则首个
  const picked = a.all ? hits : [hits[0]];
  const out = picked.map(el => {
    const target = climbAncestors(el, a.ancestor || 0) || el;
    const ref = registerRef(target);
    const tag = target.tagName.toLowerCase();
    // text 用元素自身直接文本(与 locate 一致,不子树聚合)
    const text = ownElText(target).slice(0, 60);
    return { ref, tag, text, line: lineOf(target, ref) };
  });
  return setResult({ ok: true, hits: out });
})();
