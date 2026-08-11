/**
 * view-core.ts — 结构视图建视图 core(从 DOM 采集精简树)。
 * 被 view 入口与操作反馈(feedback-collect)共享:把"整棵 DOM 区域 → 内部 ViewNode 树"的逻辑集中于此。
 * 含 DOM 采集(simplify)与 visible-only 裁剪(prune),与纯变换(formatView/markText)分离。
 *
 * 注意:buildView 不重置 __cdpRefs；已登记元素复用旧号，首次见到的元素只在表尾追加。
 */
import type { ViewNode } from './view-format.ts';
import { tmpFolds } from './fold.ts';
import type { FoldItem } from './arg.ts';
import { linkIgnored } from './ignore-links.ts';
import { cut, isPureCount } from './view-utils.ts';
import { registerRef } from './find-root.ts';

export interface ViewBuildOpts { visibleOnly?: boolean; viewport?: boolean; folds?: FoldItem[]; ignoreLinks?: string[]; maxLen?: number }

const DROP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'PATH', 'BR', 'IFRAME', 'PICTURE', 'SOURCE', 'USE']);
/** 压空白 + 零宽字符、首尾 trim 的归一化(供文本采集/比对统一用)。 */
export const strip = (s: string) => (s || '').replace(/[​‌‍⁠﻿\s]+/g, ' ').trim();
/** 折叠子树元素数:穿透 children + shadowRoot、跳过 DROP 标签,供折叠行 ▸ 备注 (N) 显示规模。 */
const countEls = (root: Element | ShadowRoot): number => {
  const kids = Array.from(root.children);
  if (root instanceof Element && root.shadowRoot) kids.push(...Array.from(root.shadowRoot.children));
  let n = 0;
  for (const c of kids) { if (c instanceof Element && DROP.has(c.tagName)) continue; n += 1 + countEls(c as Element); }
  return n;
};
const ownText = (el: Element) => {
  const parts: string[] = [];
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) parts.push(n.nodeValue);
  return strip(parts.join(' '));
};
// 穿透 shadow DOM 收集整棵子树的文本(深度上限 d<8 防爆炸)。
const grabText = (el: Element | ShadowRoot, d: number): string => {
  const gt = el instanceof Element ? el.tagName : '';
  if (gt === 'STYLE' || gt === 'SCRIPT' || gt === 'TEMPLATE' || gt === 'NOSCRIPT' || gt === 'LINK' || gt === 'META' || gt === 'TITLE') return '';
  const parts: string[] = [];
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) parts.push(n.nodeValue);
  if (d < 8) {
    if (el instanceof Element && el.shadowRoot) parts.push(grabText(el.shadowRoot, d + 1));
    for (let i = 0; i < el.children.length; i++) parts.push(grabText(el.children[i], d + 1));
  }
  return parts.join(' ');
};
/** 取元素自身**直接**子文本节点拼成的文本(不含子元素文本,空白归一化)。find/locate 都要避免子树聚合误导。 */
export const ownElText = (el: Element): string => ownText(el);
/** 穿透 shadow 取整棵子树文本(空格分隔)。供 find 文本搜索比对"元素或后代是否含关键词"。 */
export const subtreeText = (el: Element | ShadowRoot): string => strip(grabText(el, 0));
// 泛化:children 含 light DOM + shadowRoot 子(穿透 Web Component shadow DOM,如 B站评论区)
/** 取元素的 light 子 + shadowRoot 子(穿透 Web Component shadow DOM,如 B站评论区)。 */
export const childrenOf = (el: Element): (Element | ShadowRoot)[] => {
  const k: (Element | ShadowRoot)[] = [];
  for (let i = 0; i < el.children.length; i++) k.push(el.children[i]);
  if (el.shadowRoot) for (let i = 0; i < el.shadowRoot.children.length; i++) k.push(el.shadowRoot.children[i]);
  return k;
};
const interactive = (el: Element): boolean => {
  const t = el.tagName;
  if (t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
  return el.hasAttribute ? (el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.getAttribute('role') === 'button') : false;
};
// visible-only:元素是否落在当前视口内且可见(非 display:none/opacity:0/visibility:hidden)。
// rect 宽高为 0 即 display:none(不占位);再查 opacity/visibility。getComputedStyle 较贵,只在 rect 相交后查。
const isInView = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.top >= innerHeight || r.bottom <= 0 || r.left >= innerWidth || r.right <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.opacity !== '0';
};
// 便宜的在视区判定(viewport 标记用):只查 rect 与视口相交 + 宽高>0,不查 getComputedStyle(省开销)。
export const isInViewport = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return !(r.top >= innerHeight || r.bottom <= 0 || r.left >= innerWidth || r.right <= 0);
};
// visible-only 裁剪:返回"子树是否含视口内可见节点"。非视口但有视口内后代的节点退化为纯容器骨架
// (清空自身文本/ref,让 formatView 不输出视口外的内容),但保留 kids 供进入视口内的后代显示。
function prune(n: ViewNode): boolean {
  n.kids = n.kids.filter(k => prune(k));
  const hasView = !!n.inView || n.kids.length > 0;
  if (!n.inView) {
    n.text = ''; n.leafValue = undefined; n.imgAlt = ''; n.ref = undefined; n.agg = false;
    n.isContent = false; n.inputInfo = undefined;
  }
  return hasView;
}

/** 交互元素的语义标签:aria-label → title → data-tooltip → 直接文本。
 * 无文本图标按钮(点赞/分享等)有 aria-label/title 时,view 显示其功能、article 降级标注,而非裸 `button [ref=N]`。
 * data-tooltip 兜底:知乎(B站等)纯图标按钮常把提示放 data-tooltip(如 "解释这篇内容"),无 aria/title 时须借它,
 * 否则 view 只能裸 `button [ref=N]`、agent 看不出含义。 */
export const elLabel = (el: Element): string => {
  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria) return aria;
  const t = el.getAttribute && el.getAttribute('title');
  if (t) return t;
  const tip = el.getAttribute && el.getAttribute('data-tooltip');
  if (tip) return tip;
  return ownText(el);
};

/** 从 root 建精简树。opts.visibleOnly:建视图后按视口可见裁剪(沿用 view --visible-only 语义);
 * opts.viewport:对带 ref 的节点算 node.view(输出 [ref=i, visible] 标记),见 lib/view-format.ts。
 *
 * ref 两遍先序登记:遍一(simplify)建树 + 打标记(wantRef/wantHidden)+ 暂存 el,**不登记 __cdpRefs**;
 * 遍二(assign)按先序 DFS 复用或追加 ref；输出仍按树序，但复用后的数字不保证单调。
 * 每次 assign 都按本次树位置刷新 parentRef，SPA 重排后跳表仍指向当前最近已登记祖先。 */
export function buildView(root: Element | ShadowRoot, opts: ViewBuildOpts = {}): ViewNode {
  const visibleOnly = !!opts.visibleOnly;
  const viewport = !!opts.viewport;
  // 折叠规则来源:持久(Node 侧 folds.ts 按 hostname 过滤后传入)+ 会话级临时(__cdpFolds)。统一按 selector 匹配。
  const folds: FoldItem[] = [...(opts.folds || []), ...tmpFolds()];
  // 折叠判定:元素命中任一 fold selector → 返回备注,否则 null。
  const foldNote = (el: Element): string | null => {
    for (const f of folds) { try { if (el.matches(f.selector)) return f.note || f.selector; } catch {} }
    return null;
  };
  // 子树是否含"内容"节点(自身 isContent 或任一后代):判断纯容器是否在叶子路径上(有内容可包裹才登记隐藏 ref)。
  const subtreeHasContent = (n: ViewNode): boolean => n.isContent || n.kids.some(subtreeHasContent);
  // 链接黑名单(Node 侧 ignore-links.ts 读入后传入):命中黑名单的 <a> 内联成纯文本,与相邻文本段合并。
  const ignoreLinks: string[] = opts.ignoreLinks || [];

  // 判断节点是否为可内联合并的"行内文本段":直接 mergeable(span 直接文本 / 命中黑名单的 a),
  // 或**单子节点纯包装 span**(如 <span><a>漕</a></span>,文本藏在内层)穿透递归视为同段。
  // 返回该段文本 + 末段 el(ref)。非行内文本返回 null。
  const inlineTextOf = (n: ViewNode | undefined): { text: string; el?: Element } | null => {
    if (!n) return null;
    if (n.mergeable) return { text: n.text || '', el: n.el };
    // 纯包装 span(无自身文本/交互/shadow/表单)且恰含一个可内联子节点 → 透传其文本/el
    if (n.tag === 'span' && !n.inter && !n.shadow && !n.inputInfo && !n.text && n.kids.length === 1) {
      const inner = inlineTextOf(n.kids[0]);
      if (inner) return inner;
    }
    return null;
  };

  // 判断元素是否直接命中 ignore-links(自身是 <a> 且 href 命中)。
  const isIgnoredAEl = (k: Element): boolean => {
    const h = k.getAttribute('href') || '';
    return k.tagName === 'A' && !!h && ignoreLinks.length > 0 && linkIgnored(ignoreLinks, h);
  };
  // 父元素是否有直接文本子节点(非空)。
  const hasDirectText = (el: Element): boolean => {
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && (n.nodeValue || '').trim()) return true;
    return false;
  };
  // 父元素是否有紧邻的 ignore 链接子元素(直接 <a> 或单层 <span><a>):这些链接周围是父的文本片段。
  const hasImmediateIgnoredA = (el: Element): boolean => {
    for (const k of Array.from(el.children)) {
      if (isIgnoredAEl(k)) return true;
      if (k.tagName === 'SPAN' && k.children.length === 1 && isIgnoredAEl(k.children[0])) return true;
    }
    return false;
  };
  // 直接文本片段(无 el,无独立 ref):并入保序片段,供 mergeTextRuns 与相邻 ignore 链接合并。
  const textSegment = (v: string): ViewNode => ({
    tag: 'span', isContent: true, text: v, inter: false, ref: undefined,
    mergeable: true, wantRef: false, el: undefined, inView: true, view: false,
    imgAlt: '', inputInfo: undefined, shadow: false, kids: [], size: 1, hasText: true, agg: false,
  });

  // 合并相邻行内文本段(span 文本 / 命中 ignore-links 的 a):折成一个文本段,取**最后一段**的 el(ref)。
  // 如 p 下 [span"设立", span>a"漕", span"，这世上"] 命中黑名单 → 合并为 "设立漕，这世上",el 取最后 span。
  function mergeTextRuns(kids: ViewNode[]): ViewNode[] {
    const out: ViewNode[] = [];
    let i = 0;
    while (i < kids.length) {
      const k = kids[i];
      const seg = inlineTextOf(k);
      if (seg && inlineTextOf(kids[i + 1])) {
        let text = '';
        let lastEl: Element | undefined;
        let lastView: boolean | undefined;
        let lastInView: boolean | undefined;
        let j = i;
        while (j < kids.length) {
          const s = inlineTextOf(kids[j]);
          if (!s) break;
          text += s.text;
          if (s.el) { lastEl = s.el; lastView = kids[j].view; lastInView = kids[j].inView; }
          j++;
        }
        out.push({
          tag: 'span', isContent: true, text, inter: false, ref: undefined,
          wantRef: true, el: lastEl, inView: lastInView, view: lastView,
          imgAlt: '', inputInfo: undefined, shadow: false, kids: [], size: 1,
          hasText: true, agg: false,
        });
        i = j;
      } else {
        out.push(k); i++;
      }
    }
    return out;
  }

  // —— 遍一:建树 + 打标记 + 暂存 el。不登记 __cdpRefs ——
  function simplify(el: Element | ShadowRoot, depth: number): ViewNode | null {
    const isEl = el instanceof Element;
    // 折叠(非根元素命中 fold 规则):标 wantRef(可展开)、设 fold=备注、不递归子树。
    // 根不折叠:view <ref> 展开折叠容器时,根本身(=该容器)不该再被折叠,否则永远展不开。
    if (isEl && depth > 0) {
      const note = foldNote(el as Element);
      if (note !== null) {
        const e = el as Element;
        return {
          tag: e.tagName.toLowerCase(), isContent: true, text: '', inter: false, ref: undefined,
          wantRef: true, el: e, inView: true, view: viewport ? isInViewport(e) : undefined, imgAlt: '',
          shadow: !!e.shadowRoot, kids: [], size: 1, hasText: false, agg: false, fold: note,
          foldSize: countEls(e),
        };
      }
    }
    const tag = isEl ? el.tagName?.toLowerCase() || 'frag' : 'frag';
    const inter = isEl ? interactive(el as Element) : false;
    const title = isEl ? (el.getAttribute('title') || '') : '';
    let text = isEl ? ownText(el as Element) : '';
    // visible-only 下只登记视口内可见内容节点的 ref,序号连续、输出的 [ref=i] 都指向真实可操作元素。
    const inView = visibleOnly && isEl ? isInView(el as Element) : true;
    // 带 shadowRoot 的 host(如 bili-comments)无条件标 wantRef:它们常无 light 文本、首屏还是空壳,
    // 不强制登记就会在整页 view 里静默消失,agent 无从知道页面有评论区。登记后 formatView 输出占位行。
    const hasShadow = isEl && inView && !!(el as Element).shadowRoot;
    // 命中链接黑名单的 <a>:内联成纯文本(inter 降为 false),与相邻文本段合并(view 里不单独成链接行)。
    const ignoredA = isEl && tag === 'a' && ignoreLinks.length
      ? linkIgnored(ignoreLinks, ((el as Element).getAttribute('href') || '')) : false;
    const effInter = ignoredA ? false : inter;
    // 模式 B:父元素既有直接文本、又有紧邻的 ignore 链接(直接 <a> 或 span>a)→ 用保序 childNodes 组装,
    // 让文本片段与链接文本按原序成段(兄弟 span 模式 A 由 mergeTextRuns 处理,不走此分支)。
    const ordered = isEl && !ignoredA && ignoreLinks.length > 0
      && hasDirectText(el as Element) && hasImmediateIgnoredA(el as Element);
    if (ordered) text = ''; // 直接文本改由保序片段承载,不再合成到自身 text
    const node: ViewNode = {
      tag,
      // shadow host 强制 isContent:空壳 host(无文本、shadow 子树也未加载)也要被 walk 到、输出占位,
      // 否则会被 productive 过滤掉,agent 在整页 view 里看不到它存在。
      isContent: !!text || (isEl && el.tagName === 'IMG') || effInter || hasShadow,
      text, inter: effInter, ref: undefined, inView, view: viewport ? isInViewport(el as Element) : undefined,
      wantRef: isEl && inView && (effInter || !!text || hasShadow) ? true : undefined,
      // 纯文本段(span 直接文本)或命中黑名单的 a → 可与相邻文本段合并
      mergeable: (ignoredA || (tag === 'span' && !!text && !effInter && !hasShadow)) ? true : undefined,
      el: isEl ? el as Element : undefined,
      imgAlt: isEl && el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '',
      // 表单元素采集 type/value/placeholder(view 显示),让 agent 看到搜索框内容、不必 eval。
      // textarea 采 value/placeholder;input 采 type/value/placeholder;select 不采(options 由交互展开)。
      inputInfo: isEl && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
        ? {
            type: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : undefined,
            value: cut(((el as any).value || ''), opts.maxLen),
            placeholder: el.getAttribute('placeholder') || undefined,
          }
        : undefined,
      // 宿主带 shadowRoot:其下的子节点展平自 shadow DOM,CSS 选择器无法穿透,须用 ref 定位
      shadow: hasShadow,
      kids: [], size: 0, hasText: false, agg: false,
    };
    if (ordered) {
      // 保序组装:直接文本节点 → mergeable 片段;元素子节点 → 正常 simplify。顺序与 DOM 一致。
      for (const n of Array.from((el as Element).childNodes)) {
        if (n.nodeType === 3) {
          const v = (n.nodeValue || '').trim();
          if (v) node.kids.push(textSegment(v));
        } else if (n.nodeType === 1) {
          const kt = (n as Element).tagName.toUpperCase();
          if (DROP.has(kt)) continue;
          const kn = simplify(n as Element, depth + 1);
          if (kn) node.kids.push(kn);
        }
      }
    } else {
      for (const k of childrenOf(el as Element)) {
        const kt = k instanceof Element ? k.tagName.toUpperCase() : '';
        if (DROP.has(kt)) continue;
        const kn = simplify(k, depth + 1);
        if (kn) node.kids.push(kn); // 跳过被排除的 null
      }
    }
    // ignore-links:相邻纯文本段(span / 命中黑名单的 a)合并成一段,取最后段 el(ref)。
    node.kids = mergeTextRuns(node.kids);
    if (!text && !node.kids.length) { text = cut(strip(grabText(el, 0)), opts.maxLen); node.agg = true; }
    // 交互/图片元素自身无直接文本时,先试语义标签(aria/title),再 grabText 聚合后代文本
    // (空格分隔,穿透 shadow;替代 innerText——后者会把 inline 数字连排成 "822.2万904906:02")。
    if (!text && effInter) {
      const label = elLabel(el as Element);
      if (label) { text = cut(strip(label), opts.maxLen); node.agg = true; }
      else { text = cut(strip(grabText(el, 0)), opts.maxLen); node.agg = true; }
    }
    // 交互元素直接文本是"纯计数"(如收藏数"3"、浏览"1.2万"),aria/title 才携带语义(如"收藏")。
    // 合并显示 "收藏 3"——否则 agent 只见裸数字,把收藏数/浏览数误当评论数/点赞数(知乎收藏按钮即此类)。
    else if (text && effInter) {
      const aria = (el as Element).getAttribute('aria-label');
      const ti = (el as Element).getAttribute('title');
      const sem = aria || ti;
      if (sem && isPureCount(text)) { text = cut(strip(sem + ' ' + text), opts.maxLen); node.agg = true; }
    }
    else if (!text && ignoredA) {
      text = cut(strip(grabText(el as Element, 0)), opts.maxLen); node.agg = true;
    } else if (!text && isEl && el.tagName === 'IMG') {
      text = cut(strip(grabText(el, 0)), opts.maxLen); node.agg = true;
    }
    node.text = text;
    node.isContent = !!text || (isEl && el.tagName === 'IMG') || effInter || hasShadow;
    node.size = 1 + node.kids.reduce((a, k) => a + k.size, 0);
    if (!text && title && !node.kids.some(k => k.text) && node.size <= 8 && (el as Element).tagName !== 'SVG' && (el as Element).tagName !== 'path' && (el as Element).tagName !== 'USE') {
      node.leafValue = cut(strip(title), opts.maxLen);
      node.isContent = true;
    }
    // 隐藏容器:纯包装元素(无自身文本/交互/shadow/表单),但子树含内容(叶子路径上的祖父 div)。
    // 标 wantHidden(遍二登记进 __cdpRefs,可被 view <ref>/fold/locate/info 定位),**不设 node.ref** ——
    // formatView 不输出其 [ref=N],view 默认不显示、内联折叠行为不变。parentRef 由遍二用最近已登记祖先填。
    if (isEl && inView && !effInter && !text && !hasShadow && !node.inputInfo
        && node.kids.length > 0 && subtreeHasContent(node)) {
      node.wantHidden = true;
      node.hidden = true;
    }
    return node;
  }

  // —— 遍二:先序 DFS 分配 ref + parentRef。wantRef→设 node.ref 并打印;wantHidden→登记但不打印 ——
  function assign(n: ViewNode, parentRef: number | null): void {
    let childParent: number | null = parentRef;
    if ((n.wantRef || n.wantHidden) && n.el) {
      const ref = registerRef(n.el, parentRef);
      if (n.wantRef) n.ref = ref;
      childParent = ref;
    }
    for (const k of n.kids) assign(k, childParent);
  }

  let v = simplify(root, 0);
  if (!v) v = { tag: 'body', isContent: false, text: '', inter: false, ref: undefined, inView: true, view: false, imgAlt: '', shadow: false, kids: [], size: 0, hasText: false, agg: false };
  assign(v, null);
  if (visibleOnly) { v.kids = v.kids.filter(k => prune(k)); }
  return v;
}
