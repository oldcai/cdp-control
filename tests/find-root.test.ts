/**
 * find-root.test.ts — findRoot / refElement / climbAncestors / shadow 检测与穿透链单测
 * (Node 内置 node:test,零依赖)。依赖 document.querySelector / 元素 .shadowRoot / getRootNode,
 * 用假对象单测。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { findRoot, refElement, climbAncestors, entryEl, entryParent, inShadow, outermostHost, buildShadowChain } from '../src/inject/lib/find-root.ts';

type RefTestGlobals = typeof globalThis & { __cdpRefs?: unknown[] };
const refGlobals = globalThis as RefTestGlobals;

// ---- 全局 stub:document.querySelector(各测试填 uniqueSel) ----
const uniqueSel = new Map<string, any>();
function stubDocument() {
  (globalThis as any).document = {
    querySelector: (sel: string) => uniqueSel.get(sel) ?? null,
    get body() { return uniqueSel.get('body'); },
  };
}

// ---- 全局 stub:ShadowRoot(浏览器原生,Node 没有)。inShadow/outermostHost/buildShadowChain
// 靠 el.getRootNode() instanceof ShadowRoot 判定,故伪造一个类让假 root 实例命中。 ----
class FakeShadowRoot {
  host: any;
  constructor(host: any) { this.host = host; }
}
(globalThis as any).ShadowRoot = FakeShadowRoot;

/** CSS.escape stub(genSel 用)。 */
(globalThis as any).CSS = { escape: (s: string) => s };

beforeEach(() => { uniqueSel.clear(); stubDocument(); });

/** 构造含 parentElement/children 的假元素链。 */
type FakeChainElement = {
  tagName: string;
  nodeType: 1;
  isConnected: boolean;
  parentElement: FakeChainElement | null;
  children: FakeChainElement[];
};

function makeChain(...tags: string[]): Element[] {
  const els: FakeChainElement[] = [];
  for (const t of tags) {
    const el: FakeChainElement = { tagName: t, nodeType: 1, isConnected: true, parentElement: null, children: [] };
    if (els.length) { el.parentElement = els[els.length - 1]; els[els.length - 1].children.push(el); }
    els.push(el);
  }
  return els as unknown as Element[]; // [0]=最上层根 ... [n-1]=最深层叶
}

test('refElement: 按序号取真实元素', () => {
  const [a, mid, leaf] = makeChain('div', 'div', 'span');
  refGlobals.__cdpRefs = [a, mid, leaf];
  assert.equal(refElement(0), a);
  assert.equal(refElement(2), leaf);
  assert.equal(refElement(3), null);      // 越界
  assert.equal(refElement(-1), null);
});

test('refElement: 兼容旧 {el} 与新 {elRef} 槽位', () => {
  const [legacy, weak] = makeChain('div', 'button');
  refGlobals.__cdpRefs = [
    { el: legacy, parentRef: null },
    { elRef: new WeakRef(weak), parentRef: 0 },
  ];
  assert.equal(refElement(0), legacy);
  assert.equal(refElement(1), weak);
});

test('refElement: WeakRef 已释放或元素 detached 均按 stale 返回 null', () => {
  const detached = { nodeType: 1, isConnected: false } as unknown as Element;
  const released = { deref: () => undefined } as unknown as WeakRef<Element>;
  const releasedEntry = { elRef: released, parentRef: 0 };
  refGlobals.__cdpRefs = [
    { elRef: new WeakRef(detached), parentRef: null },
    releasedEntry,
  ];
  assert.equal(refElement(0), null);
  assert.equal(refElement(1), null);
  assert.equal(entryEl(releasedEntry), undefined);
  assert.equal(entryParent(releasedEntry), 0);
});

test('refElement: 非元素节点(如文本节点)不入 ref,返回 null', () => {
  refGlobals.__cdpRefs = [{ nodeType: 3, textContent: 'x' }];
  assert.equal(refElement(0), null);
  refGlobals.__cdpRefs = undefined;
  assert.equal(refElement(0), null);
});

test('climbAncestors: 不爬返回自身;按层爬父;遇根停', () => {
  const [a, b, c, leaf] = makeChain('div', 'div', 'div', 'span');
  assert.equal(climbAncestors(leaf, 0), leaf);
  assert.equal(climbAncestors(leaf, 1), c);
  assert.equal(climbAncestors(leaf, 3), a);
  assert.equal(climbAncestors(leaf, 99), a); // 超过根停在最上层
  assert.equal(climbAncestors(null, 2), null);
});

// ---- findRoot:普通 selector + shadow 链 >>> 穿透 ----

test('findRoot: 无 selector 返回 body', () => {
  const body = { tag: 'body' };
  uniqueSel.set('body', body);
  assert.equal(findRoot(undefined), body);
  assert.equal(findRoot(''), body);
});

test('findRoot: 普通 selector 走 document.querySelector', () => {
  const el = { tag: 'main' };
  uniqueSel.set('#main', el);
  assert.equal(findRoot('#main'), el);
  assert.equal(findRoot('.miss'), null);
});

/** 造假 shadowRoot:含独立 querySelector 表。 */
function mkShadow(queryMap: Record<string, any>) {
  return { querySelector: (sel: string) => queryMap[sel] ?? null };
}

test('findRoot: shadow 链 a >>> b 逐段穿透 shadowRoot', () => {
  const inner = { tag: 'a' };
  const host = { tag: 'div', shadowRoot: mkShadow({ 'a': inner }) };
  uniqueSel.set('div', host);
  // 'div >>> a' → document.querySelector('div') → host.shadowRoot.querySelector('a') → inner
  assert.equal(findRoot('div >>> a'), inner);
});

test('findRoot: 多层 shadow 链 a >>> b >>> c', () => {
  const deepest = { tag: 'span' };
  const midShadow = mkShadow({ 'span': deepest });
  const midHost = { tag: 'section', shadowRoot: midShadow };
  const topShadow = mkShadow({ 'section': midHost });
  const topHost = { tag: 'div', shadowRoot: topShadow };
  uniqueSel.set('div', topHost);
  assert.equal(findRoot('div >>> section >>> span'), deepest);
});

test('findRoot: shadow 链第一段在 document 未命中 → null', () => {
  const host = { tag: 'div', shadowRoot: mkShadow({ 'a': {} }) };
  uniqueSel.set('div', host);
  assert.equal(findRoot('.miss >>> a'), null);
});

test('findRoot: 中段元素无 shadowRoot → null', () => {
  // host 命中但没有 shadowRoot(普通元素),第二段无法穿透
  const host = { tag: 'div' }; // 无 shadowRoot
  uniqueSel.set('div', host);
  assert.equal(findRoot('div >>> a'), null);
});

test('findRoot: shadow 内最后一段未命中 → null', () => {
  const host = { tag: 'div', shadowRoot: mkShadow({}) };
  uniqueSel.set('div', host);
  assert.equal(findRoot('div >>> .miss'), null);
});

test('findRoot: >>> 周围带空白会被 trim', () => {
  const inner = { tag: 'a' };
  const host = { tag: 'div', shadowRoot: mkShadow({ 'a': inner }) };
  uniqueSel.set('div', host);
  assert.equal(findRoot('div  >>>  a'), inner);
});


// ---- shadow 检测 / 穿透链生成(inShadow / outermostHost / buildShadowChain) ----

/**
 * 造假元素:含 tag/parentElement/children/getRootNode。getRootNode 默认返回自己(light DOM)。
 * 关键:shadow 边界处 parentElement 为 null(shadow 根的直接子元素 parentElement=null),
 * 故本工具的 shadowScopedChain 自然收口。测试构造时,shadow 内父子关系靠 parentElement 显式接,
 * 但"shadow 根直接子"必须 parentElement=null。
 */
function mkEl(tag: string): any {
  return {
    tagName: tag, nodeType: 1, parentElement: null as any, children: [] as any[],
    getRootNode: function (this: any) { return this; },
  };
}

/** 把 el 标记为"在 host 的 shadow 内":getRootNode() 返回 FakeShadowRoot(host)。 */
function inShadowOf(el: any, host: any) {
  const root = new FakeShadowRoot(host);
  el.getRootNode = () => root;
}

/** 链接子→父(双向:设置 parentElement + push 到 children)。 */
function link(parent: any, child: any) {
  child.parentElement = parent;
  parent.children.push(child);
}

/** 让假 document 支持 querySelectorAll(genSel 的 isUnique 用;sel 在 uniqueSel 表里算 1)。 */
function stubDocAll() {
  const doc = (globalThis as any).document;
  doc.querySelectorAll = (sel: string) => ({ length: uniqueSel.has(sel) ? 1 : 0 });
}

test('inShadow: light DOM 元素返回 false;shadow 内返回 true', () => {
  stubDocAll();
  assert.equal(inShadow(mkEl('span')), false);
  assert.equal(inShadow(null), false);
  const host = mkEl('div');
  const inner = mkEl('span');
  inShadowOf(inner, host);
  assert.equal(inShadow(inner), true);
});

test('outermostHost: 单层 shadow → 该层 host;多层 → 最外层 host;light → null', () => {
  stubDocAll();
  // 单层:host0(light) ← shadow ← el
  const host0 = mkEl('div'); host0.id = 'h0';
  const el = mkEl('a');
  inShadowOf(el, host0);
  assert.equal(outermostHost(el), host0);
  // 多层:host0(light) ← SR0 ← host1 ← SR1 ← el
  const host1 = mkEl('section');
  inShadowOf(host1, host0); // host1 在 host0 的 shadow 内
  inShadowOf(el, host1);    // el 在 host1 的 shadow 内
  assert.equal(outermostHost(el), host0);
  // light 元素
  assert.equal(outermostHost(mkEl('span')), null);
});

test('buildShadowChain: light 元素返回 null', () => {
  stubDocAll();
  assert.equal(buildShadowChain(mkEl('a')), null);
});

test('buildShadowChain: 单层 shadow → hostSel >>> 内层相对链', () => {
  stubDocAll();
  // 结构:host(div#wrap, light) —shadow→ ul > a(target);ul 是 shadow 根直接子(parentElement=null)
  const host = mkEl('div'); host.id = 'wrap';
  const ul = mkEl('ul');   // shadow 根直接子(parentElement=null)
  const a1 = mkEl('a');
  const a2 = mkEl('a');    // target
  link(ul, a1); link(ul, a2);          // shadow 内部链接 ul→a1/a2
  inShadowOf(ul, host); inShadowOf(a1, host); inShadowOf(a2, host);
  uniqueSel.set('#wrap', host); // genSel(host) = '#wrap'(selfAnchor id 命中)
  const chain = buildShadowChain(a2);
  // 首段 host selector;第二段:ul(根直接子收口) > a:nth-of-type(2)
  assert.equal(chain, '#wrap >>> ul > a:nth-of-type(2)');
});

test('buildShadowChain: 多层 shadow → 最外层 hostSel >>> 中间链 >>> 最内链', () => {
  stubDocAll();
  // 结构:host0(div#outer, light) —SR0→ host1(section,SR0 根直接子) —SR1→ a(target,SR1 根直接子)
  const host0 = mkEl('div'); host0.id = 'outer';
  const host1 = mkEl('section'); // SR0 根直接子
  const el = mkEl('a');          // SR1 根直接子
  inShadowOf(host1, host0);
  inShadowOf(el, host1);
  // host1 / el 都是各自 shadow 根直接子 → parentElement=null,shadowScopedChain 返回单 tag
  uniqueSel.set('#outer', host0);
  const chain = buildShadowChain(el);
  // host0 在 light(genSel=#outer);host1 在 SR0 内(单 tag section);el 在 SR1 内(单 tag a)
  assert.equal(chain, '#outer >>> section >>> a');
});

test('buildShadowChain: 同名兄弟正确带序号(回归 nth-of-type 语义)', () => {
  stubDocAll();
  // host —shadow→ div(wrap) > span(c1), span(c2=target)
  const host = mkEl('div'); host.id = 'h';
  const wrap = mkEl('div');    // shadow 根直接子
  const c1 = mkEl('span');
  const c2 = mkEl('span');     // target
  link(wrap, c1); link(wrap, c2);
  inShadowOf(wrap, host); inShadowOf(c1, host); inShadowOf(c2, host);
  uniqueSel.set('#h', host);
  // wrap 单子不带序号;c2 是第二个 span → span:nth-of-type(2)
  assert.equal(buildShadowChain(c2), '#h >>> div > span:nth-of-type(2)');
});

test('buildShadowChain 与 findRoot 闭环:链能被 findRoot 穿透解析', () => {
  stubDocAll();
  // host —shadow→ ul > a(target);给 host 装 shadowRoot.querySelector 表模拟穿透
  const host = mkEl('div'); host.id = 'wrap';
  const ul = mkEl('ul');
  const a = mkEl('a');
  link(ul, a);
  inShadowOf(ul, host); inShadowOf(a, host);
  uniqueSel.set('#wrap', host);
  (host as any).shadowRoot = { querySelector: (sel: string) => (sel === 'ul > a' ? a : null) };
  const chain = buildShadowChain(a);
  assert.equal(chain, '#wrap >>> ul > a');
  assert.equal(findRoot(chain!), a); // findRoot 能穿透回 a(闭环)
});
