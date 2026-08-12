/**
 * genSel.test.ts — genSel 的纯函数单测(Node 内置 node:test,零依赖)。
 * 用假元素(含 parentElement/children/id/getAttribute/attributes/classList)模拟 DOM;
 * 注入全局 document.querySelector(All) 模拟浏览器唯一性判定(CSS.escape 也补上)。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { genSel } from '../src/inject/lib/genSel.ts';

// ---- 全局 stub:CSS.escape + document.querySelector(All) ----
Object.defineProperty(globalThis, 'CSS', { value: { escape: (s: string) => s }, configurable: true });

/** sel → 元素 的"唯一命中表"(测试预设,模拟 document.querySelector)。 */
const uniqueSel = new Map<string, FakeElement>();
/** sel → 命中数 的"唯一性表"(模拟 querySelectorAll().length;默认 0)。 */
const selCount = new Map<string, number>();

function stubDocument() {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: (sel: string) => uniqueSel.get(sel) ?? null,
      querySelectorAll: (sel: string) => {
        const n = selCount.get(sel) ?? 0;
        return {
          length: n,
          item: () => null,
          [Symbol.iterator]() {
            return [][Symbol.iterator]();
          },
        };
      },
    },
  });
}
beforeEach(() => {
  uniqueSel.clear();
  selCount.clear();
  stubDocument();
});

/** 注册某 sel 唯一命中 el(同时进 uniqueSel 和 selCount=1)。 */
function only(sel: string, el: FakeElement) {
  uniqueSel.set(sel, el);
  selCount.set(sel, 1);
}

/** 构造假元素:含 parentElement/children/id/getAttribute/attributes/classList。 */
interface FakeAttribute {
  name: string;
  value: string;
}

interface FakeElement {
  tagName: string;
  nodeType: 1;
  id: string;
  parentElement: FakeElement | null;
  children: FakeElement[];
  attributes: { length: number; item(index: number): FakeAttribute | null; [index: number]: FakeAttribute };
  getAttribute(name: string): string | null;
  classList: { length: number; item(index: number): string | null };
}

function mk(
  tag: string,
  parent: FakeElement | null = null,
  opts: { id?: string; attrs?: Record<string, string>; classList?: string[] } = {},
): FakeElement {
  const { id = '', attrs = {}, classList = [] } = opts;
  const attrMap = { ...(id ? { id } : {}), ...attrs };
  const entries = Object.entries(attrMap);
  const attributesObj: FakeElement['attributes'] = {
    length: entries.length,
    item: (i: number) => (entries[i] ? { name: entries[i][0], value: entries[i][1] } : null),
  };
  for (let i = 0; i < entries.length; i++) attributesObj[i] = { name: entries[i][0], value: entries[i][1] };
  const el: FakeElement = {
    tagName: tag,
    nodeType: 1,
    id,
    parentElement: parent,
    children: [],
    attributes: attributesObj,
    getAttribute: (n: string) => attrMap[n] ?? null,
    get classList() {
      const list = classList;
      return {
        length: list.length,
        item: (index: number) => list[index] ?? null,
      };
    },
  };
  return el;
}

function select(el: FakeElement | null): string | null {
  return genSel(el as unknown as Element | null);
}

test('genSel: null/无效 → null', () => {
  assert.equal(select(null), null);
});

test('genSel: 有 id 优先(id 唯一命中自己)', () => {
  const el = mk('div', null, { id: 'box' });
  only('#box', el);
  assert.equal(select(el), '#box');
});

test('genSel: 重复 id 不误锚(查询命中非自己 → 退路)', () => {
  // el 带 id="dup",但 document.querySelector('#dup') 命中的是别的元素
  const other = mk('div', null, { id: 'dup' });
  only('#dup', other);
  const parent = mk('body');
  const el = mk('div', parent, { id: 'dup' });
  parent.children = [el];
  // id 不锚定后无其它锚点,退回 body > div 位置链(body 单子不带序号)
  assert.equal(select(el), 'body > div');
});

test('genSel: data-testid 全文档唯一 → 锚定', () => {
  const el = mk('button', null, { attrs: { 'data-testid': 'submit' } });
  only('button[data-testid="submit"]', el);
  assert.equal(select(el), 'button[data-testid="submit"]');
});

test('genSel: data-testid 与多元素共用(非唯一)→ 退回下一优先级', () => {
  const el = mk('button', null, { attrs: { 'data-testid': 'submit' }, classList: ['btn'] });
  // data-testid 不唯一(命中数 2)
  selCount.set('button[data-testid="submit"]', 2);
  // 唯一 class 兜底
  only('.btn', el);
  assert.equal(select(el), '.btn');
});

test('genSel: 测试锚点优先级 data-testid > data-test > data-cy > data-qa', () => {
  const el = mk('button', null, { attrs: { 'data-testid': 'a', 'data-test': 'b', 'data-cy': 'c', 'data-qa': 'd' } });
  // 多个都唯一,但应取 data-testid(最先检查)
  only('button[data-testid="a"]', el);
  only('button[data-test="b"]', el);
  only('button[data-cy="c"]', el);
  only('button[data-qa="d"]', el);
  assert.equal(select(el), 'button[data-testid="a"]');
});

test('genSel: 语义 data-* (data-role) 唯一 → 锚定', () => {
  const el = mk('nav', null, { attrs: { 'data-role': 'main-nav' } });
  only('nav[data-role="main-nav"]', el);
  assert.equal(select(el), 'nav[data-role="main-nav"]');
});

test('genSel: 语义 data-* 名优先于泛化 data-*', () => {
  const el = mk('div', null, { attrs: { 'data-foo': 'x', 'data-role': 'r' } });
  only('div[data-role="r"]', el);
  only('div[data-foo="x"]', el);
  assert.equal(select(el), 'div[data-role="r"]');
});

test('genSel: aria-label 唯一 → 锚定', () => {
  const el = mk('section', null, { attrs: { 'aria-label': '搜索' } });
  only('section[aria-label="搜索"]', el);
  assert.equal(select(el), 'section[aria-label="搜索"]');
});

test('genSel: 某 class 全文档唯一 → .cls', () => {
  const el = mk('span', null, { classList: ['icon', 'common'] });
  // 'common' 非唯一,'icon' 唯一 → 用 .icon
  selCount.set('.common', 5);
  only('.icon', el);
  assert.equal(select(el), '.icon');
});

test('genSel: 祖先有 id 时锚定祖先 + 下方位置链(精确命中 el)', () => {
  // 结构: body > div#root > ul > li(target)
  const body = mk('body');
  const root = mk('div', body, { id: 'root' });
  const ul = mk('ul', root);
  const li1 = mk('li', ul);
  const li2 = mk('li', ul); // target
  body.children = [root];
  root.children = [ul];
  ul.children = [li1, li2];
  only('#root', root);
  // 组合 selector 必须精确命中 target(matchesEl 校验)
  only('#root > ul > li:nth-of-type(2)', li2);
  // target 自己无锚点 → 找到祖先 #root 锚定 + 下方 ul > li:nth-of-type(2)
  assert.equal(select(li2), '#root > ul > li:nth-of-type(2)');
});

test('genSel: 祖先有 data-testid 锚定 + 下方链', () => {
  // 结构: header[data-testid="bar"] > nav > a(target)
  const header = mk('header', null, { attrs: { 'data-testid': 'bar' } });
  const nav = mk('nav', header);
  const a = mk('a', nav);
  header.children = [nav];
  nav.children = [a];
  only('header[data-testid="bar"]', header);
  only('header[data-testid="bar"] > nav > a', a);
  assert.equal(select(a), 'header[data-testid="bar"] > nav > a');
});

test('genSel: 锚点祖先下方链不精确命中 el → 继续向上,最终兜底纯位置链', () => {
  // 边界:#root 锚定后 selector 命中的不是 el(模拟),应放弃、继续上爬
  const body = mk('body');
  const root = mk('div', body, { id: 'root' });
  const mid = mk('div', root);
  const target = mk('span', mid);
  body.children = [root];
  root.children = [mid];
  mid.children = [target];
  only('#root', root);
  // 覆盖 querySelector:#root 仍命中 root 自己,但组合 selector 命中 null(不精确)
  // 祖先锚定不够精确 → 继续向上(body 无锚点)→ 兜底纯 tag:nth-of-type 链
  // 兜底链不含 id(纯位置,与原 genSel 一致):span→div(mid)→div(root)→body(body 为伪造根)
  const result = select(target);
  assert.equal(result, 'body > div > div > span');
});

test('genSel: 无任何锚点 → 纯 nth-of-type 位置链(回归原行为)', () => {
  const html = mk('html');
  const body = mk('body', html);
  html.children = [body];
  const d1 = mk('div', body);
  const d2 = mk('div', body);
  body.children = [d1, d2];
  // 无 id/data-*/aria/class → 兜底位置链
  assert.equal(select(d2), 'html > body > div:nth-of-type(2)');
});

test('genSel: 无锚点链根段(html)无 parentElement 不带序号', () => {
  const html = mk('html');
  assert.equal(select(html), 'html');
});

test('genSel: 接口签名 (el) => string|null 不变', () => {
  const el = mk('div', null, { id: 'x' });
  only('#x', el);
  const typed: (value: Element | null) => string | null = genSel;
  const r: string | null = typed(el as unknown as Element);
  assert.equal(r, '#x');
  assert.equal(typed(null), null);
});
