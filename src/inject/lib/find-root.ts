/**
 * find-root.ts — 从 selector 求建视图根元素 + ref 解析 + shadow 检测/穿透链(注入侧,无 Node 依赖)。
 * 被 view / locate / 操作动作入口复用。xpath 已退役,定位只走 selector + ref。
 */
import { genSel } from './genSel.ts';

/** __cdpRefs 新槽位用 WeakRef 避免 pin 住 detached DOM;旧 {el} / 裸 Element 继续兼容读取。 */
export type RefEntry =
  | { elRef: WeakRef<Element>; parentRef: number | null }
  | { el: Element; parentRef: number | null }
  | Element;

type RefGlobals = typeof globalThis & {
  __cdpRefs?: RefEntry[];
  __cdpRefIndex?: WeakMap<Element, number>;
};

const refGlobals = globalThis as RefGlobals;

/** 取 __cdpRefs 数组(可能为 undefined / 空)。 */
export function getRefs(): RefEntry[] | undefined {
  return refGlobals.__cdpRefs;
}

/** entry 取元素(兼容 {elRef,parentRef} / {el,parentRef} / 裸 Element 三种形态)。 */
export function entryEl(entry: RefEntry | undefined): Element | undefined {
  if (!entry) return undefined;
  if (typeof Element !== 'undefined' && entry instanceof Element) return entry;
  if ('elRef' in entry) return entry.elRef.deref();
  if ('el' in entry) return entry.el;
  return entry;
}

/** entry 取 parentRef(裸 Element 形态无 parentRef,视作根 → null)。 */
export function entryParent(entry: RefEntry | undefined): number | null {
  if (!entry || (typeof Element !== 'undefined' && entry instanceof Element) || !('parentRef' in entry)) return null;
  return entry.parentRef ?? null;
}

/**
 * 确保反向索引存在。首次遇到旧表时一次性回填索引，并把仍可达的旧强引用槽位升级成 WeakRef。
 * 同一元素若历史上被重复登记，保留最早印发的号码；后续登记不会让旧号换指向。
 */
function ensureRefIndex(refs: RefEntry[]): WeakMap<Element, number> {
  if (refGlobals.__cdpRefIndex) return refGlobals.__cdpRefIndex;
  const index = new WeakMap<Element, number>();
  for (let ref = 0; ref < refs.length; ref++) {
    const entry = refs[ref];
    const el = entryEl(entry);
    if (!el) continue;
    if (!index.has(el)) index.set(el, ref);
    if (!('elRef' in entry)) {
      refs[ref] = { elRef: new WeakRef(el), parentRef: entryParent(entry) };
    }
  }
  refGlobals.__cdpRefIndex = index;
  return index;
}

/** O(1) 反查已登记元素；只查不注册，供 probe 使用。 */
export function lookupRef(el: Element | null | undefined): number | null {
  if (!el) return null;
  const ref = refGlobals.__cdpRefIndex?.get(el);
  if (ref == null) return null;
  return entryEl(refGlobals.__cdpRefs?.[ref]) === el ? ref : null;
}

/**
 * 统一登记入口：已登记元素复用原号，首次见到的元素只在表尾追加。
 * parentRef 传值时刷新跳表父链；省略时复用旧槽位父链，新槽位按 null 登记。
 */
export function registerRef(el: Element, parentRef?: number | null): number {
  const refs = refGlobals.__cdpRefs || (refGlobals.__cdpRefs = []);
  const index = ensureRefIndex(refs);
  const oldRef = index.get(el);
  if (oldRef != null && entryEl(refs[oldRef]) === el) {
    const nextParent = parentRef === undefined ? entryParent(refs[oldRef]) : parentRef;
    refs[oldRef] = { elRef: new WeakRef(el), parentRef: nextParent };
    return oldRef;
  }
  if (oldRef != null) index.delete(el);
  const ref = refs.length;
  refs.push({ elRef: new WeakRef(el), parentRef: parentRef ?? null });
  index.set(el, ref);
  return ref;
}

/** ref 失效自愈的分类(纯逻辑,无 DOM 调用,可单测):
 *  - 'none':无登记表(当前 document 尚未 view / 登记),无可恢复。
 *  - 'never':ref 越界或该槽从未登记(agent 打错号),不走跳表自愈。maxRef 给文案核对。
 *  - 'live':曾登记,需沿 parentRef 链找首个仍 connected 的祖先。start=起始跳表号。 */
export type RefClass =
  | { kind: 'none' }
  | { kind: 'never'; maxRef: number }
  | { kind: 'live'; start: number; maxRef: number };

export function classifyRef(ref: number): RefClass {
  const refs = getRefs();
  if (!refs || !refs.length) return { kind: 'none' };
  const maxRef = refs.length - 1;
  if (ref < 0 || ref > maxRef || !refs[ref]) return { kind: 'never', maxRef };
  return { kind: 'live', start: ref, maxRef };
}

/**
 * 求建视图根元素:selector 命中返回首个元素,否则 body。
 * selector 未命中返回 null(由调用方决定是否报错)。
 *
 * 支持 shadow 链:`a >>> b >>> c`。`>>>` 是本工具自定义的 shadow 穿透分隔符(非标准 CSS),
 * 由 locate 对 shadow 内元素生成,让 `view --selector-file` 能复用。解析方式:
 *   第一段在 document 上 querySelector;之后每段在前一段元素的 shadowRoot 上 querySelector,
 *   逐层穿透(标准 CSS 无法跨 shadow 边界)。任一段未命中 / host 无 shadowRoot → null。
 */
export function findRoot(selector?: string): Element | null {
  if (!selector) return document.body;
  const parts = selector.split('>>>').map(s => s.trim());
  if (parts.length === 1) return document.querySelector(parts[0]);
  // shadow 链:逐段穿透 shadowRoot
  let node: any = document.querySelector(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    if (!node || !node.shadowRoot) return null;
    node = node.shadowRoot.querySelector(parts[i]);
  }
  return node ?? null;
}

/**
 * 全部命中版:querySelectorAll,逐个返回。供 find --selector --all 用。
 * shadow 链语义同 findRoot:首段 document,之后每段在上段 host 的 shadowRoot 上 querySelectorAll。
 * 链尾用 querySelectorAll 收集全部;非链直接 document.querySelectorAll。
 * 任一段未命中 / host 无 shadowRoot → 返回空数组。
 */
export function findRootAll(selector: string): Element[] {
  if (!selector) return [];
  const parts = selector.split('>>>').map(s => s.trim());
  if (parts.length === 1) return Array.from(document.querySelectorAll(parts[0]));
  // shadow 链:前 n-1 段逐段穿透(每段取首个 host),末段 querySelectorAll 收全部
  let node: any = document.querySelector(parts[0]);
  for (let i = 1; i < parts.length - 1; i++) {
    if (!node || !node.shadowRoot) return [];
    node = node.shadowRoot.querySelector(parts[i]);
  }
  if (!node || !node.shadowRoot) return [];
  return Array.from(node.shadowRoot.querySelectorAll(parts[parts.length - 1]));
}

/**
 * 按 view 输出的 ref 序号取真实元素(ref 存于 window.__cdpRefs,会话句柄)。
 * 页面导航/刷新换 document 后自然得到新的全局登记表,旧 ref 此时返回 null。
 * view / locate 共用同一解析:先取 ref 元素,再 climbAncestors 爬到目标容器。
 */
export function refElement(ref: number): Element | null {
  const el = entryEl(getRefs()?.[ref]);
  return el?.nodeType === 1 && el.isConnected ? el : null;
}

/**
 * 从元素向上爬 ancestor 层父级(默认 0 = 不爬,返回自身)。
 * 用来把"内容叶子的 ref"抬升到"语义区域容器"——纯包装容器本身无 ref,只能从叶子往上爬。
 * 遇无父元素(html 或 shadow 边界)即停。
 */
export function climbAncestors(el: Element | null, ancestor = 0): Element | null {
  let e = el;
  for (let i = 0; i < ancestor; i++) if (e && e.parentElement) e = e.parentElement;
  return e;
}

// —— shadow DOM 检测与穿透链(locate 检测 shadow 元素 + 生成 >>> 链,findRoot 消费) ——

/** 元素是否在 shadow DOM 内(根节点是 ShadowRoot)。 */
export function inShadow(el: Element | null): boolean {
  if (!el) return false;
  const root = (el as any).getRootNode ? (el as any).getRootNode() : null;
  return !!root && root instanceof ShadowRoot;
}

/**
 * 动作入口(click/fill/focus/hover)回显 selector 用:shadow 内元素不回废 selector
 * (querySelector 查不到,会误导 agent),只标 shadow:true,由 CLI 提示用 ref 操作。
 * light 元素返回 genSel + shadow:false。
 */
export function actionSelector(el: Element): { shadow: boolean; selector: string | null } {
  if (inShadow(el)) return { shadow: true, selector: null };
  return { shadow: false, selector: genSel(el) };
}

/** 取元素所在 shadowRoot 的 host(若在 shadow 内,否则 null)。 */
function shadowHost(el: Element): Element | null {
  const root = (el as any).getRootNode && (el as any).getRootNode();
  return root && root instanceof ShadowRoot ? (root as ShadowRoot).host : null;
}

/** 取元素最外层 host(沿 shadowRoot.host 上爬到落在 light DOM 的那个;元素不在 shadow 内返回 null)。 */
export function outermostHost(el: Element): Element | null {
  let h = shadowHost(el);
  if (!h) return null;
  while (true) {
    const outer = shadowHost(h);
    if (!outer) return h;
    h = outer;
  }
}

/**
 * 从 shadow 内元素向上到本层 shadowRoot 的 host(不含 host)的相对 :nth-of-type 链。
 * shadow 边界 parentElement 为 null,故自然停在 shadow 根下。
 * 这是"该 shadow 层内"的相对 selector,在 host.shadowRoot.querySelector 上有效。
 */
function shadowScopedChain(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur) {
    const parent: Element | null = cur.parentElement;
    let part = cur.tagName.toLowerCase();
    // 在父的子中按同名兄弟序号定位(parent 为 null = shadow 根直接子,单 tag 不带序号)
    if (parent) {
      const sibs = Array.from(parent.children).filter(c => c.tagName === cur!.tagName);
      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
    }
    parts.unshift(part);
    if (!parent) break; // shadow 边界(shadow 根直接子的 parentElement=null):本段已记,止
    cur = parent;
  }
  return parts.join(' > ');
}

/**
 * 生成 shadow 穿透 selector 链:host0Sel >>> seg1 >>> seg2 >>> ... (locate 输出,findRoot 消费)。
 * 元素不在 shadow 内 → 返回 null。
 *
 * 链语义:首段是 light DOM 中最外层 host 的 selector(走 document.querySelector);
 * 之后每段在前一段 host 的 shadowRoot 上 querySelector,逐层向内。每段是"该 shadow 根范围内"
 * 的相对链(:nth-of-type,shadow 边界 parentElement=null 自然收口)。
 *
 * 构造方式:先沿 getRootNode 收集 [el, host1, host2, ..., 最外层 host](每个 host 在更外层 shadow 内,
 * 直到某个 host 落在 light DOM)。然后从最外层往内逐段拼:最外层 host 取 genSel(light DOM,有效),
 * 内层每段取"该层 shadow 根范围内、到下一层目标(host 或最终 el)的相对链"。
 */
export function buildShadowChain(el: Element): string | null {
  if (!inShadow(el)) return null;
  // 收集宿主链:targets[0]=el(最内), targets[1]=内层 host, ..., targets[n]=最外层 host(light DOM)。
  const targets: Element[] = [];
  let cur: Element | null = el;
  while (cur && inShadow(cur)) {
    targets.push(cur);
    cur = shadowHost(cur);
  }
  if (cur) targets.push(cur); // 最外层 host(在 light DOM,inShadow=false,不在循环内 push)
  // 从最外层向内拼:首段 = 最外层 host 的 genSel(light DOM,document 上有效);
  // 之后每段 = 上层 shadow 根范围内到下一目标的相对链(host 或 el)。
  // targets[length-1-k] 是第 k 层 shadow 内的目标(k=1 为最外层 shadow 内的下一 host,末层为 el)。
  const hostSel = genSel(targets[targets.length - 1]);
  if (!hostSel) return null; // 最外层 host 无 selector(理论不会,防御)
  const parts: string[] = [hostSel];
  for (let k = 1; k <= targets.length - 1; k++) {
    parts.push(shadowScopedChain(targets[targets.length - 1 - k]));
  }
  return parts.join(' >>> ');
}
