/**
 * view-budget.test.ts — 预算折叠决策纯函数单测。
 * 不依赖 DOM：直接构造已分配稳定 ref 的 ViewNode，锁定排序、预算逼近、骨架与 maxLen 语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { formatView, markText, type ViewNode } from '../src/inject/lib/view-format.ts';
import {
  formatApproxChars,
  renderBudgetedView,
  renderFocusedBudgetedView,
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

test('renderBudgetedView: 优先折更细的大文本区域，够用即停', () => {
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

  assert.deepEqual(result.foldedRefs, [2], '后代文本区域已足够达标，不回退折粗 section');
  assert.equal(result.withinBudget, true);
  assert.ok(result.used <= 280);
  assert.ok(result.lines.some(line => line.includes('▸ [ref=2] p (1 个元素')));
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
  assert.deepEqual(result.foldedRefs, [214], '优先折更细的后代，保留尽可能多的结构');
  assert.ok(result.lines[0].includes('[ref=48]'));
  assert.ok(result.lines.some(line => line.includes('▸ [ref=214]')));
});

test('renderBudgetedView: 隐藏包装节点用 budgetRef 留下可展开骨架，且不改写任何 ref', () => {
  const children = [9, 10, 11].map(ref => textNode(ref, '内容'.repeat(100)));
  const hidden = mk({ tag: 'main', hidden: true, budgetRef: 8, kids: children, size: 4 });
  const root = prepare(mk({ tag: 'body', kids: [hidden], size: 5 }));
  const before = structuredClone(root);

  const result = renderBudgetedView(root, 180);

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
  assert.equal(formatApproxChars(999_999), '1m');
  assert.equal(formatApproxChars(1_250_000), '1.3m');
});

test('renderFocusedBudgetedView: 整页非焦点区域全折，只展开焦点路径与子树', () => {
  const header = mk({ tag: 'header', budgetRef: 1, kids: [textNode(2, '顶栏内容'.repeat(30))], size: 2 });
  const focus = mk({ tag: 'article', budgetRef: 4, ref: 4, kids: [textNode(5, '目标正文')], size: 2 });
  const main = mk({ tag: 'main', budgetRef: 3, kids: [focus], size: 3 });
  const footer = mk({ tag: 'footer', budgetRef: 6, kids: [textNode(7, '页脚内容'.repeat(30))], size: 2 });
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
  const nav = mk({ tag: 'nav', budgetRef: 1, kids: [textNode(2, '导航'.repeat(80))], size: 2 });
  const root = prepare(mk({ tag: 'body', kids: [nav, focus], size: 8 }));

  const result = renderFocusedBudgetedView(root, 330, 10);

  assert.deepEqual(result.foldedRefs, [1, 12], '焦点内只折达到预算所需的最细长文本区域');
  assert.ok(!result.foldedRefs.includes(10));
  assert.ok(result.lines.some(line => line.includes('▸ [ref=12] p')));
  assert.ok(result.lines.some(line => line.includes('乙'.repeat(60))));
  assert.ok(result.used <= 330);
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
  const innerHost = mk({
    tag: 'x-thread', shadow: true, ref: 21, budgetRef: 21,
    kids: [focus], size: 2,
  });
  const outerHost = mk({
    tag: 'x-comments', shadow: true, ref: 20, budgetRef: 20,
    kids: [innerHost], size: 3,
  });
  const root = prepare(mk({ tag: 'body', kids: [outerHost], size: 4 }));

  const result = renderFocusedBudgetedView(root, 500, 22);

  assert.ok(result.lines.some(line => line.includes('深层 shadow 评论')));
  assert.ok(!result.lines.includes('  x-comments[shadow] [ref=20]'));
  assert.ok(!result.lines.some(line => line.includes('x-thread[shadow] [ref=21]')));
});

test('renderFocusedBudgetedView: 折叠摘要更长的琐碎区域保持原样', () => {
  const separator = mk({ tag: 'span', isContent: true, text: '/', ref: 1, budgetRef: 1, size: 1 });
  const focus = textNode(2, '焦点正文');
  const wrapper = mk({ tag: 'main', budgetRef: 0, kids: [separator, focus], size: 3 });
  const root = prepare(mk({ tag: 'body', kids: [wrapper], size: 4 }));

  const result = renderFocusedBudgetedView(root, 500, 2);

  assert.ok(!result.lines.some(line => line.includes('▸ [ref=1] span')));
  assert.ok(!result.foldedRefs.includes(1));
  assert.ok(result.lines.some(line => line.includes('焦点正文')));
});

test('renderFocusedBudgetedView: 焦点外的短节点不应被更长摘要反向膨胀', () => {
  const chips = Array.from({ length: 150 }, (_, index) => mk({
    tag: 'a', isContent: true, inter: true, text: `标签${index}`,
    ref: index + 1, budgetRef: index + 1, size: 1,
  }));
  const focus = mk({
    tag: 'article', isContent: true, text: '焦点正文', ref: 9001, budgetRef: 9001,
    kids: [textNode(9010, '正文'.repeat(20))], size: 2,
  });
  const root = prepare(mk({ tag: 'body', kids: [...chips, focus], size: 153 }));
  const plainChars = formatView(root).join('\n').length;

  const result = renderFocusedBudgetedView(root, 8000, 9001);

  assert.equal(result.withinBudget, true);
  assert.equal(result.foldedRefs.length, 0, '折叠短链接只会让输出更长');
  assert.ok(result.used <= plainChars + 80, `focus 输出 ${result.used} 不应远大于原树 ${plainChars}`);
});

test('renderBudgetedView: 数千平级候选以单次 span 分析和有界校正避免全树平方重算', () => {
  const count = 3000;
  const kids = Array.from({ length: count }, (_, index) => textNode(index + 1, '甲'.repeat(100)));
  const root = prepare(mk({ tag: 'body', kids, size: count + 1 }));

  const started = performance.now();
  const result = renderBudgetedView(root, 1);
  const elapsedMs = performance.now() - started;

  assert.equal(result.foldedRefs.length, count);
  assert.ok(elapsedMs < 3000, `3000 个平级候选耗时 ${Math.round(elapsedMs)}ms，不应逐候选重渲染整树`);
});

test('renderBudgetedView: 单包装大页应在预算内保留尽可能多的渐进骨架', () => {
  let ref = 1;
  const articles = Array.from({ length: 100 }, (_, index) => {
    const title = textNode(ref++, `标题${index}`);
    const body = textNode(ref++, '正文'.repeat(60));
    return mk({ tag: 'article', budgetRef: ref++, kids: [title, body], size: 3 });
  });
  const main = mk({ tag: 'main', budgetRef: ref++, kids: articles, size: 301 });
  const app = mk({ tag: 'div', budgetRef: ref++, kids: [main], size: 302 });
  const root = prepare(mk({ tag: 'body', kids: [app], size: 303 }));

  const result = renderBudgetedView(root, 8000);

  assert.equal(result.withinBudget, true);
  assert.ok(result.used >= 6000, `已用 ${result.used} 不应因折最外层而浪费几乎全部预算`);
  assert.ok(result.foldedRefs.length > 1, '应保留多个可逐步展开的区域，而不是只留应用根占位');
  assert.ok(!result.foldedRefs.includes(app.budgetRef!), '不应直接折掉整个应用根');
});

test('renderBudgetedView: 更细后代已足够达标时不因粗祖先更接近预算而回退', () => {
  const child = textNode(2, '甲'.repeat(500));
  const wrapper = mk({
    tag: 'very-very-very-very-very-very-long-wrapper',
    budgetRef: 1,
    kids: [child],
    size: 2,
  });
  const root = prepare(mk({ tag: 'body', kids: [wrapper], size: 3 }));

  const result = renderBudgetedView(root, 200);

  assert.equal(result.withinBudget, true);
  assert.deepEqual(result.foldedRefs, [2], '后代方案能达标时应保留可逐层展开的包装骨架');
});

test('renderBudgetedView: shadow host 的整页占位不得按局部展开体量倒置排名', () => {
  let ref = 1;
  const shadowKids = Array.from({ length: 80 }, () => textNode(ref++, '评论'.repeat(60)));
  const host = mk({
    tag: 'x-comments', shadow: true, ref: 8001, budgetRef: 8001,
    kids: shadowKids, size: 81,
  });
  const paragraphs = Array.from({ length: 50 }, (_, index) => textNode(ref++, `小段落文本${index}`));
  const section = mk({ tag: 'section', budgetRef: 8002, kids: [host, ...paragraphs], size: 132 });
  const root = prepare(mk({ tag: 'body', kids: [section], size: 133 }));

  const result = renderBudgetedView(root, 300);

  assert.equal(result.withinBudget, true);
  assert.ok(result.foldedRefs.includes(8002), '应能折叠真正占用整页输出的 section');
  assert.ok(!result.foldedRefs.includes(8001), 'shadow host 本来就是短占位，不应当作大子树');
});

test('renderBudgetedView: 深层单子链的候选分析不重复渲染每一层子树', () => {
  const count = 1500;
  let current = textNode(count, '甲'.repeat(100));
  for (let ref = count - 1; ref >= 1; ref--) {
    current = mk({ tag: 'div', budgetRef: ref, kids: [current], size: current.size + 1 });
  }
  const root = prepare(mk({ tag: 'body', kids: [current], size: current.size + 1 }));

  const started = performance.now();
  const result = renderBudgetedView(root, 1);
  const elapsedMs = performance.now() - started;

  assert.equal(result.foldedRefs.length, 1);
  assert.ok(elapsedMs < 3000, `1500 层单子链耗时 ${Math.round(elapsedMs)}ms，不应逐层重渲染`);
});

test('renderBudgetedView: 深链仅轻微超预算时规划不应重复穷举同一子问题', () => {
  const count = 100;
  let current = textNode(count, '甲'.repeat(200));
  for (let ref = count - 1; ref >= 1; ref--) {
    current = mk({ tag: 'div', budgetRef: ref, kids: [current], size: current.size + 1 });
  }
  const root = prepare(mk({ tag: 'body', kids: [current], size: current.size + 1 }));
  const plainChars = formatView(root).join('\n').length;

  const started = performance.now();
  const result = renderBudgetedView(root, plainChars + 35);
  const elapsedMs = performance.now() - started;

  assert.ok(result.foldedRefs.length > 0, '基线+账单应刚好超预算并触发规划');
  assert.ok(elapsedMs < 3000, `100 层轻微超预算耗时 ${Math.round(elapsedMs)}ms，同一 target 子问题必须复用`);
});

test('renderBudgetedView: 深层分支树不应为大子树传播指数个不同 target', () => {
  const levels = 150;
  let current = textNode(10_000, '甲'.repeat(400));
  for (let level = levels; level >= 1; level--) {
    const sibling = textNode(level, '乙'.repeat(50 + level * 7));
    current = mk({
      tag: 'div',
      budgetRef: 1000 + level,
      kids: [sibling, current],
      size: current.size + 2,
    });
  }
  const root = prepare(mk({ tag: 'body', kids: [current], size: current.size + 1 }));

  const started = performance.now();
  const result = renderBudgetedView(root, 51_750);
  const elapsedMs = performance.now() - started;

  assert.equal(result.withinBudget, true);
  assert.ok(elapsedMs < 1000, `150 层分支树耗时 ${Math.round(elapsedMs)}ms，规划应保持有界`);
});
