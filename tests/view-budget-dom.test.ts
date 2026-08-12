/**
 * view-budget-dom.test.ts — 用最小假 DOM 做 buildView → 预算折叠端到端断言。
 * 不启动浏览器、不依赖 jsdom；重点锁定两遍 ref 分配完成后预算渲染绝不改号。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { entryEl, type RefEntry } from '../src/inject/lib/find-root.ts';
import { buildView } from '../src/inject/lib/view-core.ts';
import { markText, type ViewNode } from '../src/inject/lib/view-format.ts';
import { renderBudgetedView } from '../src/inject/lib/view-budget.ts';

class FakeText {
  readonly nodeType = 3;
  readonly nodeValue: string;
  constructor(nodeValue: string) {
    this.nodeValue = nodeValue;
  }
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

  text(value: string): this {
    this.childNodes.push(new FakeText(value));
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  matches(selector: string): boolean {
    return this.attrs.get('data-selector') === selector;
  }
  getBoundingClientRect() {
    return { width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 };
  }
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

test('构造 DOM: focus 重建时放开持久 fold 的祖先路径并复用后代 ref', () => {
  const target = new FakeElement('p', '折叠区里的目标正文');
  const folded = new FakeElement('section').attr('data-selector', '.folded').append(target);
  const body = new FakeElement('body').append(folded);
  const globals = globalThis as typeof globalThis & TestGlobals;
  globals.__cdpRefs = [];
  globals.__cdpRefIndex = new WeakMap<Element, number>();
  globals.__cdpFolds = [];
  const folds = [{ selector: '.folded', note: '持久折叠区' }];

  const collapsedTree = buildView(body as unknown as Element, { folds });
  assert.equal(collapsedTree.kids[0].fold, '持久折叠区');
  assert.equal(collapsedTree.kids[0].kids.length, 0);

  const localTree = buildView(folded as unknown as Element, { folds });
  const targetRef = localTree.kids[0].ref;
  assert.notEqual(targetRef, undefined, '局部展开 fold 根后应能拿到后代 ref');

  const focusedTree = buildView(body as unknown as Element, {
    folds,
    unfoldPathTo: target as unknown as Element,
  });
  assert.equal(focusedTree.kids[0].fold, undefined, 'focus 路径上的 fold 根必须展开');
  assert.equal(focusedTree.kids[0].kids[0].ref, targetRef, 'focus 重建后复用既有后代 ref');
});

test('构造 DOM: 合并文本节点的 ref 不覆盖整段内容，不得生成不可回展开的预算占位', () => {
  const ignoredLink = new FakeElement('a', '术语').attr('href', 'https://zhida.zhihu.com/search?q=x');
  const paragraph = new FakeElement('p').text('前文'.repeat(80)).append(ignoredLink).text('后文'.repeat(80));
  const globals = globalThis as typeof globalThis & TestGlobals;
  globals.__cdpRefs = [];
  globals.__cdpRefIndex = new WeakMap<Element, number>();
  globals.__cdpFolds = [];

  const tree = buildView(paragraph as unknown as Element, { ignoreLinks: ['zhida.zhihu.com/search*'] });
  markText(tree);
  const synthetic = tree.kids.find((node: ViewNode) => node.budgetFoldable === false);
  assert.notEqual(synthetic, undefined, '相邻正文与忽略链接应合并成不可独立展开的文本节点');

  const result = renderBudgetedView(tree, 1);
  assert.ok(!result.foldedRefs.includes(synthetic?.budgetRef ?? -1));
  assert.equal(result.withinBudget, false, '没有覆盖完整文本的合法子树时宁可如实超预算，也不能给错误展开句柄');
});
