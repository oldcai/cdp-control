/**
 * view-budget-dom.test.ts — 用最小假 DOM 做 buildView → 预算折叠端到端断言。
 * 不启动浏览器、不依赖 jsdom；重点锁定两遍 ref 分配完成后预算渲染绝不改号。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { entryEl, type RefEntry } from '../src/inject/lib/find-root.ts';
import { buildView } from '../src/inject/lib/view-core.ts';
import { markText } from '../src/inject/lib/view-format.ts';
import { renderBudgetedView } from '../src/inject/lib/view-budget.ts';

class FakeText {
  readonly nodeType = 3;
  readonly nodeValue: string;
  constructor(nodeValue: string) { this.nodeValue = nodeValue; }
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly shadowRoot = null;
  parentElement: FakeElement | null = null;
  private readonly attrs = new Map<string, string>();

  constructor(tag: string, text?: string) {
    this.tagName = tag.toUpperCase();
    if (text) this.childNodes.push(new FakeText(text));
  }

  append(child: FakeElement): this {
    child.parentElement = this;
    this.children.push(child);
    this.childNodes.push(child);
    return this;
  }

  attr(name: string, value: string): this {
    this.attrs.set(name, value);
    return this;
  }

  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  matches(): boolean { return false; }
  getBoundingClientRect() { return { width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 }; }
}

interface TestGlobals {
  __cdpRefs?: RefEntry[];
  __cdpRefIndex?: WeakMap<Element, number>;
  __cdpFolds?: Array<{ selector: string; note: string }>;
}

const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'Element');
const originalShadowRoot = Object.getOwnPropertyDescriptor(globalThis, 'ShadowRoot');
const originalInnerHeight = Object.getOwnPropertyDescriptor(globalThis, 'innerHeight');
const originalInnerWidth = Object.getOwnPropertyDescriptor(globalThis, 'innerWidth');

Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement });
Object.defineProperty(globalThis, 'ShadowRoot', { configurable: true, value: class FakeShadowRoot {} });
Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 800 });
Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1200 });

after(() => {
  const restore = (key: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  };
  restore('Element', originalElement);
  restore('ShadowRoot', originalShadowRoot);
  restore('innerHeight', originalInnerHeight);
  restore('innerWidth', originalInnerWidth);
});

test('构造 DOM: buildView 先分配全部 ref，预算折叠只替换渲染且保留可展开句柄', () => {
  const paragraph = new FakeElement('p', '正文'.repeat(100));
  const button = new FakeElement('button', '展开评论').attr('aria-label', '展开评论');
  const main = new FakeElement('main').append(paragraph).append(button);
  const body = new FakeElement('body').append(main);
  const globals = globalThis as typeof globalThis & TestGlobals;
  globals.__cdpRefs = [];
  globals.__cdpRefIndex = new WeakMap<Element, number>();
  globals.__cdpFolds = [];

  const tree = buildView(body as unknown as Element, { viewport: true });
  markText(tree);
  const refsBefore = [...(globals.__cdpRefs ?? [])];

  assert.equal(tree.budgetRef, 0, '根包装节点沿用第一个隐藏登记号');
  assert.equal(tree.kids[0].budgetRef, 1, 'main 包装节点有预算占位句柄但默认不打印 ref');
  assert.equal(tree.kids[0].kids[0].ref, 2);
  assert.equal(tree.kids[0].kids[1].ref, 3);

  const result = renderBudgetedView(tree, 160);

  assert.deepEqual(result.foldedRefs, [1]);
  assert.ok(result.lines.some(line => line.includes('▸ [ref=1] main')));
  assert.deepEqual(globals.__cdpRefs, refsBefore, '预算折叠后 ref 表元素、顺序与 parentRef 全部不变');
  assert.equal(entryEl(refsBefore[2]), paragraph as unknown as Element);
  assert.equal(entryEl(refsBefore[3]), button as unknown as Element);

  const secondTree = buildView(body as unknown as Element, { viewport: true });
  assert.equal(secondTree.kids[0].budgetRef, 1, '重复 view 应复用包装节点的稳定 ref');
  assert.equal(secondTree.kids[0].kids[0].ref, 2, '重复 view 应复用正文 ref');
  assert.equal(secondTree.kids[0].kids[1].ref, 3, '重复 view 应复用交互节点 ref');
  assert.equal(globals.__cdpRefs?.length, refsBefore.length, '重复 view 不应追加重复 ref');
});
