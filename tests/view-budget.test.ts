/**
 * view-budget.test.ts — 预算折叠决策纯函数单测。
 * 不依赖 DOM：直接构造已分配稳定 ref 的 ViewNode，锁定排序、预算逼近、骨架与 maxLen 语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { markText, type ViewNode } from '../src/inject/lib/view-format.ts';
import {
  formatApproxChars,
  renderBudgetedView,
  renderFocusedBudgetedView,
  selectNonOverlappingCandidates,
} from '../src/inject/lib/view-budget.ts';

function mk(over: Partial<ViewNode>): ViewNode {
  return {
    tag: 'div', isContent: false, text: '', inter: false, imgAlt: '', kids: [],
    size: 1, hasText: false, ...over,
  };
}

function textNode(ref: number, text: string): ViewNode {
  return mk({ tag: 'p', isContent: true, text, ref, budgetRef: ref, size: 1 });
}

function prepare(root: ViewNode): ViewNode {
  markText(root);
  return root;
}

test('renderBudgetedView: 未超预算时不折叠，但追加准确预算账', () => {
  const root = prepare(mk({ tag: 'body', kids: [textNode(1, '短内容')], size: 2 }));
  const result = renderBudgetedView(root, 200);

  assert.deepEqual(result.foldedRefs, []);
  assert.equal(result.used, result.lines.join('\n').length);
  assert.equal(result.withinBudget, true);
  assert.match(result.lines.at(-1) ?? '', /^# 预算 200 字 · 已用 \d+ · 折叠 0 处\(view <ref> 展开\)$/);
  assert.ok(result.lines.includes('  p "短内容" [ref=1]'));
});

test('renderBudgetedView: 按子树渲染体量从大到小折叠，够用即停', () => {
  const largeText = '甲'.repeat(220);
  const mediumText = '乙'.repeat(70);
  const large = mk({
    tag: 'section', budgetRef: 1, size: 2,
    kids: [textNode(2, largeText)],
  });
  const medium = mk({
    tag: 'aside', budgetRef: 3, size: 2,
    kids: [textNode(4, mediumText)],
  });
  const root = prepare(mk({ tag: 'body', kids: [large, medium], size: 5 }));

  const result = renderBudgetedView(root, 280);

  assert.deepEqual(result.foldedRefs, [1], '更大的 section 应先被折叠，进入预算后不再折 aside');
  assert.equal(result.withinBudget, true);
  assert.ok(result.used <= 280);
  assert.ok(result.lines.some(line => line.includes('▸ [ref=1] section (2 个元素')));
  assert.ok(result.lines.some(line => line.includes('~"' + '甲'.repeat(48) + '…"')));
  assert.ok(result.lines.some(line => line.includes(mediumText)), '未折叠的次大子树仍保留内容');
});

test('renderBudgetedView: 局部 view 的根永不折叠，只在其内部渐进折叠', () => {
  const inner = mk({
    tag: 'div', budgetRef: 213, ref: 213, size: 2,
    kids: [textNode(214, '评论'.repeat(100))],
  });
  const root = prepare(mk({
    tag: 'section', isContent: true, text: '评论区', ref: 48, budgetRef: 48,
    kids: [inner], size: 3,
  }));

  const result = renderBudgetedView(root, 150);

  assert.ok(!result.foldedRefs.includes(48), '视图根必须保持展开');
  assert.deepEqual(result.foldedRefs, [213]);
  assert.ok(result.lines[0].includes('[ref=48]'));
  assert.ok(result.lines.some(line => line.includes('▸ [ref=213]')));
});

test('renderBudgetedView: 隐藏包装节点用 budgetRef 留下可展开骨架，且不改写任何 ref', () => {
  const child = textNode(9, '内容'.repeat(100));
  const hidden = mk({ tag: 'main', hidden: true, budgetRef: 8, kids: [child], size: 2 });
  const root = prepare(mk({ tag: 'body', kids: [hidden], size: 3 }));
  const before = structuredClone(root);

  const result = renderBudgetedView(root, 120);

  assert.deepEqual(result.foldedRefs, [8]);
  assert.ok(result.lines.some(line => line.includes('▸ [ref=8] main')));
  assert.deepEqual(root, before, '预算决策只保存独立折叠集合，不得改树或重排 ref');
});

test('renderBudgetedView: --max-len 与总预算正交叠加', () => {
  const root = prepare(mk({ tag: 'body', kids: [textNode(1, '长文本'.repeat(80))], size: 2 }));

  const full = renderBudgetedView(root, 140);
  const truncated = renderBudgetedView(root, 140, 10);

  assert.deepEqual(full.foldedRefs, [1], '不截单条文本时需要预算折叠');
  assert.deepEqual(truncated.foldedRefs, [], '先按 maxLen 渲染后，总量已进预算则无需折叠');
  assert.ok(truncated.lines.some(line => line.includes('长文本长文本长文本长…')));
  assert.ok(truncated.used <= 140);
});

test('renderBudgetedView: 骨架和账单本身超预算时仍保留所有折叠占位并如实报超额', () => {
  const a = textNode(1, '甲'.repeat(100));
  const b = textNode(2, '乙'.repeat(100));
  const root = prepare(mk({ tag: 'body', kids: [a, b], size: 3 }));

  const result = renderBudgetedView(root, 1);

  assert.deepEqual(result.foldedRefs, [1, 2]);
  assert.equal(result.withinBudget, false);
  assert.ok(result.used > 1);
  assert.ok(result.lines.some(line => line.includes('▸ [ref=1]')));
  assert.ok(result.lines.some(line => line.includes('▸ [ref=2]')));
  assert.equal(result.used, result.lines.join('\n').length);
});

test('formatApproxChars: 紧凑显示百字、千字和百万字数量级', () => {
  assert.equal(formatApproxChars(842), '842');
  assert.equal(formatApproxChars(4200), '4.2k');
  assert.equal(formatApproxChars(12_000), '12k');
  assert.equal(formatApproxChars(1_250_000), '1.3m');
});

test('renderFocusedBudgetedView: 整页非焦点区域全折，只展开焦点路径与子树', () => {
  const header = mk({ tag: 'header', budgetRef: 1, kids: [textNode(2, '顶栏内容')], size: 2 });
  const focus = mk({ tag: 'article', budgetRef: 4, ref: 4, kids: [textNode(5, '目标正文')], size: 2 });
  const main = mk({ tag: 'main', budgetRef: 3, kids: [focus], size: 3 });
  const footer = mk({ tag: 'footer', budgetRef: 6, kids: [textNode(7, '页脚内容')], size: 2 });
  const root = prepare(mk({ tag: 'body', kids: [header, main, footer], size: 8 }));

  const result = renderFocusedBudgetedView(root, 1000, 4);

  assert.deepEqual(result.foldedRefs, [1, 6]);
  assert.ok(result.lines.some(line => line.includes('▸ [ref=1] header')));
  assert.ok(result.lines.some(line => line.includes('目标正文')));
  assert.ok(result.lines.some(line => line.includes('▸ [ref=6] footer')));
  assert.ok(!result.foldedRefs.includes(3), '焦点祖先是全局位置骨架，不得折叠');
  assert.ok(!result.foldedRefs.includes(4), '焦点根必须展开');
});

test('renderFocusedBudgetedView: 焦点子树仍超预算时只在其内部继续按体量折叠', () => {
  const large = mk({ tag: 'section', budgetRef: 11, kids: [textNode(12, '甲'.repeat(220))], size: 2 });
  const small = mk({ tag: 'aside', budgetRef: 13, kids: [textNode(14, '乙'.repeat(60))], size: 2 });
  const focus = mk({ tag: 'article', budgetRef: 10, ref: 10, kids: [large, small], size: 5 });
  const nav = mk({ tag: 'nav', budgetRef: 1, kids: [textNode(2, '导航')], size: 2 });
  const root = prepare(mk({ tag: 'body', kids: [nav, focus], size: 8 }));

  const result = renderFocusedBudgetedView(root, 300, 10);

  assert.deepEqual(result.foldedRefs, [1, 11]);
  assert.ok(!result.foldedRefs.includes(10));
  assert.ok(result.lines.some(line => line.includes('▸ [ref=11] section')));
  assert.ok(result.lines.some(line => line.includes('乙'.repeat(60))));
  assert.ok(result.used <= 300);
});

test('renderFocusedBudgetedView: 焦点是 shadow host 时展开其内部而非仍显示普通占位', () => {
  const focus = mk({
    tag: 'x-comments', shadow: true, ref: 20, budgetRef: 20,
    kids: [textNode(21, 'shadow 评论内容')], size: 2,
  });
  const root = prepare(mk({ tag: 'body', kids: [focus], size: 3 }));

  const result = renderFocusedBudgetedView(root, 500, 20);

  assert.ok(result.lines.some(line => line.includes('shadow 评论内容')));
  assert.ok(!result.lines.includes('  x-comments[shadow] [ref=20]'));
});

test('renderFocusedBudgetedView: 焦点在 shadow 内部时展开焦点路径上的所有 shadow host', () => {
  const focus = textNode(22, '深层 shadow 评论');
  const wrapper = mk({ tag: 'section', budgetRef: 21, kids: [focus], size: 2 });
  const host = mk({
    tag: 'x-comments', shadow: true, ref: 20, budgetRef: 20,
    kids: [wrapper], size: 3,
  });
  const root = prepare(mk({ tag: 'body', kids: [host], size: 4 }));

  const result = renderFocusedBudgetedView(root, 500, 22);

  assert.ok(result.lines.some(line => line.includes('深层 shadow 评论')));
  assert.ok(!result.lines.includes('  x-comments[shadow] [ref=20]'));
});

test('renderFocusedBudgetedView: 原本会被 productive 过滤的琐碎区域折叠后仍显示骨架行', () => {
  const separator = mk({ tag: 'span', isContent: true, text: '/', ref: 1, budgetRef: 1, size: 1 });
  const focus = textNode(2, '焦点正文');
  const wrapper = mk({ tag: 'main', budgetRef: 0, kids: [separator, focus], size: 3 });
  const root = prepare(mk({ tag: 'body', kids: [wrapper], size: 4 }));

  const result = renderFocusedBudgetedView(root, 500, 2);

  assert.ok(result.lines.some(line => line.includes('▸ [ref=1] span')));
  assert.ok(result.lines.some(line => line.includes('焦点正文')));
});

test('selectNonOverlappingCandidates: 后代先入选时禁止祖先随后遮住它并造成账单虚计', () => {
  const selected = selectNonOverlappingCandidates([
    { ref: 2, ancestorRefs: [1] },
    { ref: 1, ancestorRefs: [] },
    { ref: 3, ancestorRefs: [] },
  ]);

  assert.deepEqual(selected.map(candidate => candidate.ref), [2, 3]);
});

test('renderBudgetedView: 数千平级候选以有界批次渲染，不随折叠数做全树平方重算', () => {
  const count = 3000;
  const kids = Array.from({ length: count }, (_, index) => textNode(index + 1, '甲'.repeat(100)));
  const root = prepare(mk({ tag: 'body', kids, size: count + 1 }));

  const started = performance.now();
  const result = renderBudgetedView(root, 1);
  const elapsedMs = performance.now() - started;

  assert.equal(result.foldedRefs.length, count);
  assert.ok(elapsedMs < 3000, `3000 个平级候选耗时 ${Math.round(elapsedMs)}ms，应保持在有界批次内`);
});
