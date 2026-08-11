/**
 * feedback.ts — 操作后自动反馈(注入侧):MutationObserver 采集本次操作产生的 DOM 变化。
 * 分为两段,跨两次 Runtime.evaluate 调用协作,observer 状态暂存于全局 __cdpFeedback:
 *   startFeedback()   — 装 observer,记录 childList 新增 + 文本变化(前后值)。
 *   collectFeedback() — 断开 observer,取"顶层新增元素"逐块建视图拼接,产摘要。
 * 等待时长由 Node 侧(sleep)控制,不在此注入侧;node 侧在两次调用之间等待 delayMs。
 *
 * ref 语义:collect **不重置 __cdpRefs**——已登记元素复用旧号,首次见到的反馈元素从表尾追加,不顶掉整页旧 ref
 * (整页 view 才重置)。agent 用反馈树的增量 ref 操作新增内容,同时原 ref 依旧有效。
 *
 * shadow 穿透:MutationObserver 默认只观察调用 observe 的那棵树,**不进 shadowRoot**——B站点赞数、
 * 弹幕等多在 shadow 内,变化压根不进反馈。startFeedback 对 document + 所有 shadowRoot(限深度 ≤3)
 * 各起一个 observer,且 childList 新增节点若带 shadowRoot 也补装,保证 shadow 内变化能被采集。
 *
 * 噪声过滤:video/audio/canvas 子树(弹幕/播放进度/缓冲在 video 或其 shadow 内)整体跳过;
 * 连续播放时间戳(01:55→01:56…)折叠为一条。点赞数等纯数字真变化不折叠,保留为真信号。
 */
import { buildView } from './view-core.ts';
import { markText, formatView } from './view-format.ts';

export interface FeedbackResult {
  blocks: FeedbackBlock[];
  changes: FeedbackChange[];
  /** 是否发生了整页重载(document 换成新对象)。锚点/历史跳转(URL 变但同 document)为 false;
   * 整页导航为 true——此时旧 DOM/ref 全失效,增量采集无意义。Node 侧据此决定是否整页 view 重建。 */
  reloaded: boolean;
}

/** 一个去重后的新增内容块:lines 为该块 view 行,count 为它在本次出现的次数(重复块折叠)。 */
export interface FeedbackBlock { lines: string[]; count: number }

/** 一次文本变化:before 为旧值(可缺),after 为新值;note 给折叠摘要用(如"播放进度,已折叠 N 条")。 */
export interface FeedbackChange { before?: string; after: string; note?: string }

interface FeedbackState { added: Node[]; changes: FeedbackChange[]; document: Document }

/** shadow 递归观察深度上限(防极深 shadow 树导致 observer 爆炸;B站等典型页面 shadow 嵌套 ≤3)。 */
const MAX_SHADOW_DEPTH = 3;

/** 子树黑名单:这些标签的子树内的所有变化都不进反馈(弹幕/播放进度/缓冲/canvas 动画都在这)。 */
const IGNORE_SUBTREE_OF = ['VIDEO', 'AUDIO', 'CANVAS'];

/** 取 mutation 里新增/移除的直接文本节点文本。 */
const textNodes = (nodes: NodeList): string[] =>
  Array.from(nodes).filter(n => n.nodeType === 3).map(n => (n.nodeValue || '').trim()).filter(Boolean);

/**
 * 沿 parentElement + shadow host 上爬(穿透 shadow 边界),判定 node 是否在 IGNORE_SUBTREE_OF
 * 任一标签的子树内。弹幕/播放进度条等多在 <video> 的 shadow 内,变化每秒数十次,会淹没真变化。
 */
function inIgnoredSubtree(node: Node): boolean {
  let n: Node | null = node;
  while (n) {
    if (n.nodeType === 1 && IGNORE_SUBTREE_OF.includes((n as Element).tagName)) return true;
    if ((n as any).parentElement) { n = (n as any).parentElement; continue; }
    const root = (n as any).getRootNode && (n as any).getRootNode();
    n = root && root instanceof ShadowRoot ? (root as ShadowRoot).host : null;
  }
  return false;
}

/**
 * 启动反馈观察:对 document 及其所有 shadowRoot(限深度 ≤3)各起一个 MutationObserver,
 * 记录 childList 新增节点与文本变化(前后值;attributes 不进反馈,噪声大)。
 * childList 新增节点若带 shadowRoot,补装 observer,覆盖运行时挂载的 shadow host。
 * video/audio/canvas 子树内的变化整体跳过(弹幕/播放进度噪声)。
 */
export function startFeedback(): void {
  if ((globalThis as any).__cdpFeedback) return; // 已启动则复用(防重复装)
  const st: FeedbackState = { added: [], changes: [], document };
  const mos: MutationObserver[] = [];
  // callback 在所有 observer 间共享:统一推 state,并给新增带 shadowRoot 的节点补装。
  const onMutate = (ms: MutationRecord[]) => {
    for (const m of ms) {
      // 子树黑名单:target 在 video/audio/canvas 子树内(含 shadow),整个 mutation 跳过。
      if (inIgnoredSubtree(m.target)) continue;
      if (m.type === 'characterData' && m.target.nodeType === 3) {
        // 原地改字符(如点赞数字 textContent 直接改 data):characterDataOldValue 记录了旧值,拼成 旧→新。
        const before = (m.oldValue || '').trim();
        const after = ((m.target as Text).nodeValue || '').trim();
        if (after && before !== after) st.changes.push(before ? { before, after } : { after });
      } else if (m.type === 'childList') {
        // 文本替换(如 element.textContent=值 删旧加新 Text):removedNodes=旧值、addedNodes=新值,一对一配对成 旧→新。
        const befores = textNodes(m.removedNodes);
        const afters = textNodes(m.addedNodes);
        const k = Math.min(befores.length, afters.length);
        for (let i = 0; i < k; i++) st.changes.push({ before: befores[i], after: afters[i] });
        for (let i = k; i < afters.length; i++) st.changes.push({ after: afters[i] });
        // 记录新增元素节点(顶层去重靠 collect),并给带 shadowRoot 的新节点补装 observer(动态 shadow host)。
        for (const n of Array.from(m.addedNodes)) {
          if (n.nodeType === 1) {
            st.added.push(n);
            observeShadowTree(n as Element, currentDepth(m.target));
          }
        }
      }
    }
  };

  // 每棵被观察的树记录其 shadow 深度,用于新增节点补装时判定是否超限。document 视为深度 0。
  const depthMap = new Map<Node, number>();
  // 给定已观察树内任一节点,取其所属观察根的深度:先看 rootNode(观察根本身)命中,否则沿 host 链回溯。
  function currentDepth(target: Node): number {
    let n: Node | null = target;
    while (n) {
      // n 的根节点(穿过普通 DOM 树到观察根本身):若是已登记的观察根直接返回。
      const root: Node = (n as any).getRootNode ? (n as any).getRootNode() : n;
      if (depthMap.has(root)) return depthMap.get(root)!;
      // 否则跨越 shadow 边界到 host 继续上爬(host 可能在更外层观察根内)。
      if (root instanceof ShadowRoot) { n = (root as ShadowRoot).host; continue; }
      return 0; // 已到 document 且未命中(理论不会发生,document 一定登记)
    }
    return 0;
  }

  // 递归为 root 及其内所有 shadowRoot 装 observer;depth 为 root 本身的 shadow 深度(document=0)。
  function observeAll(root: Node, depth: number): void {
    const mo = new MutationObserver(onMutate);
    mo.observe(root, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    mos.push(mo);
    depthMap.set(root, depth);
    if (depth >= MAX_SHADOW_DEPTH) return; // 超深度不再下钻
    // 深度优先找 root 内带 shadowRoot 的元素,对其 shadowRoot 递归 observeAll。
    const hostEls = root instanceof Document || root instanceof ShadowRoot
      ? (root as any).querySelectorAll('*')
      : (root as Element).querySelectorAll?.('*') ?? [];
    for (const el of Array.from(hostEls)) {
      const sr = (el as Element).shadowRoot;
      if (sr) observeAll(sr, depth + 1);
    }
  }
  // 给一棵元素子树(运行时新增 host)内所有 shadowRoot 补装 observer;depth 用宿主所在观察根的深度。
  function observeShadowTree(el: Element, hostDepth: number): void {
    if (hostDepth >= MAX_SHADOW_DEPTH) return;
    const sr = (el as any).shadowRoot;
    if (sr) observeAll(sr, hostDepth + 1);
    const kids = el.querySelectorAll?.('*') ?? [];
    for (const k of Array.from(kids)) {
      const ksr = (k as Element).shadowRoot;
      if (ksr) observeAll(ksr, hostDepth + 1);
    }
  }

  observeAll(document, 0);
  (globalThis as any).__cdpFeedback = { mos, state: st };
}

/** 收尾反馈:断开 observer,把本次新增内容去重折叠 + 文本变化过滤,返回结构化结果。 */
export function collectFeedback(opts: { viewport?: boolean } = {}): FeedbackResult {
  const fb = (globalThis as any).__cdpFeedback;
  if (!fb) return { blocks: [], changes: [], reloaded: false };
  for (const mo of fb.mos as MutationObserver[]) mo.disconnect();
  (globalThis as any).__cdpFeedback = null;
  const { added, changes } = fb.state as FeedbackState;
  // 整页重载判定:装 observer 时(document)与采集时(document)是否同一对象。
  // 锚点/历史跳转 URL 变但 document 不变 → reloaded=false(ref 仍有效);整页导航换 document → true。
  const reloaded = (fb.state as FeedbackState).document !== document;
  // 顶层新增元素:本次 addedNodes 中、没有元素祖先也在本次新增集合里的节点(去嵌套,避免父容器把整棵子树又算一遍)。
  // 祖先链穿透 shadow:parentElement 在 shadow 边界为 null,改走 composedPath 思路——沿 parentNode/host 上爬。
  const els = added.filter(n => n.nodeType === 1) as Element[];
  const set = new Set(els);
  const roots = els.filter(el => !hasAncestorInSet(el, set));
  // 不重置 __cdpRefs:已登记元素复用,首次见到的反馈元素追加；顶掉旧 ref 会丢整页句柄(曾踩坑)。
  // 逐块建视图,按整块 lines 去重折叠(同内容多次出现,如广告,只留一条 + 计数)。
  const seen = new Map<string, FeedbackBlock>();
  const order: string[] = [];
  for (const el of roots) {
    const t = buildView(el, { viewport: opts.viewport });
    markText(t);
    const blines = formatView(t);
    if (!blines.length) continue;
    // 折叠签名去掉 ref 号(内容相同但 ref 不同的重复块应视为同一条,如重复广告)。
    const sig = blines.join('\n').replace(/\[ref=\d+(, visible)?\]/g, '');
    if (seen.has(sig)) { seen.get(sig)!.count++; }
    else { seen.set(sig, { lines: blines, count: 1 }); order.push(sig); }
  }
  const blocks = order.map(s => seen.get(s)!);
  // 文本变化:过滤"前后相同"(无实质变化,如广告原地刷新)+ 折叠连续播放时间戳(01:55→01:56…)为一条;去重取前 5。
  // 折叠后再去重取前 5,保证视频时间戳不挤占名额(点赞数等纯数字真变化不被折叠,自然进 changes)。
  const seenCh = new Set<string>();
  const deduped: FeedbackChange[] = [];
  for (const c of changes) {
    if (c.before && c.before === c.after) continue;
    const key = c.before ? `${c.before}→${c.after}` : `·${c.after}`;
    if (seenCh.has(key)) continue;
    seenCh.add(key);
    deduped.push(c);
  }
  const real = foldTimestampRun(deduped).slice(0, 5);
  return { blocks, changes: real, reloaded };
}

/** 沿 parentElement 上爬,穿透 shadow 边界(host),判定 el 的祖先是否在 set 内(顶层新增去嵌套用)。 */
function hasAncestorInSet(el: Element, set: Set<Element>): boolean {
  let n: Node | null = el.parentElement;
  while (n) {
    if (n.nodeType === 1 && set.has(n as Element)) return true;
    // shadow 边界:parentElement 为 null,但 rootNode 是 ShadowRoot 时跳到 host 继续。
    if ((n as any).parentElement) { n = (n as any).parentElement; continue; }
    const root = (n as any).getRootNode && (n as any).getRootNode();
    n = root && root instanceof ShadowRoot ? (root as ShadowRoot).host : null;
  }
  return false;
}

/**
 * 折叠连续播放时间戳序列:把同格式(\d{1,2}:\d{2})的 ≥3 条连续变化合并为
 * 一条 `{before: 首, after: 末, note: "播放进度,已折叠 N 条"}`。纯数字计数(如点赞数
 * 1402→1403→1404)是真信号,**不折叠**——只识别明确的时间戳格式,保守避免误杀。
 * 序列头尾任一端不是时间戳的边不进序列(原样保留);runLen<3 也原样保留(偶发同名不折叠)。
 */
export function foldTimestampRun(changes: FeedbackChange[]): FeedbackChange[] {
  const TIME = /^\d{1,2}:\d{2}$/;
  const out: FeedbackChange[] = [];
  let i = 0;
  while (i < changes.length) {
    const c = changes[i];
    const headTime = c.before != null && TIME.test(c.before) && TIME.test(c.after);
    if (!headTime) { out.push(c); i++; continue; }
    let j = i + 1;
    while (j < changes.length) {
      const d = changes[j];
      if (d.before != null && TIME.test(d.before) && TIME.test(d.after)) { j++; continue; }
      break;
    }
    const runLen = j - i;
    if (runLen < 3) {
      for (let k = i; k < j; k++) out.push(changes[k]);
    } else {
      out.push({ before: changes[i].before, after: changes[j - 1].after, note: `播放进度,已折叠 ${runLen} 条` });
    }
    i = j;
  }
  return out;
}
