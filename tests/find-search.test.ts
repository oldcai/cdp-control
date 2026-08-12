/**
 * find-search.test.ts — find --text 纯遍历逻辑单测(无 DOM 依赖)。
 *
 * 验证 lib/find-search.ts 的核心保证:
 *   1. **无硬深度上限**:30+ 层深链仍能命中(对应知乎 html>body>div×12>span×2>button = 15 层,
 *      旧 MAX_DEPTH=14 漏掉的 bug)。
 *   2. **命中即止**:命中元素的子树不再深入(避免父子重复占满结果)。
 *   3. **DROP 标签跳过**:SCRIPT/STYLE 等子树不进。
 *   4. **visited 防环**:环状结构不无限递归。
 *   5. **maxVisit 防爆炸**:访问节点数到上限就停。
 *   6. **--all 行为**:收集多个命中(分散在不同子树,不互为父子)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchByText, DEFAULT_MAX_VISIT } from '../src/inject/lib/find-search.ts';

/** 伪节点:tag + 直接文本 + 子数组(可造环、可造深链)。 */
interface N {
  tag: string;
  text?: string;
  kids?: N[];
}

const ad = {
  getChildren: (n: N) => n.kids ?? [],
  getText: (n: N) => n.text ?? '',
  isElement: (_n: N) => true, // 测试里所有节点都视为元素
  tagOf: (n: N) => n.tag,
};

test('深链命中:30+ 层 div 嵌套深处的 button 仍能命中(无硬深度上限)', () => {
  // 构造 div×30 > button(text="赞同"),共 31 层(对应旧 MAX_DEPTH=14 漏掉的 bug)
  let deepest: N = { tag: 'BUTTON', text: '赞同' };
  for (let i = 0; i < 30; i++) deepest = { tag: 'DIV', kids: [deepest] };
  const root: N = { tag: 'BODY', kids: [deepest] };
  const hits = searchByText<N>(root, '赞同', ad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, 'BUTTON');
});

test('命中即止:命中元素的子树不再深入(避免父子重复占满结果)', () => {
  // 父 div 文本含"赞",子 button 文本也含"赞"——父命中后不深入子,故只 1 命中
  const root: N = { tag: 'DIV', text: '点赞', kids: [{ tag: 'BUTTON', text: '点赞' }] };
  const hits = searchByText<N>(root, '赞', ad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, 'DIV');
});

test('--all 收集多个命中(分散在不同子树,不互为父子)', () => {
  // 三个 button 分布在三个独立子树,各自命中
  const root: N = {
    tag: 'DIV',
    kids: [
      { tag: 'BUTTON', text: '赞同 1.4 万' },
      { tag: 'DIV', kids: [{ tag: 'BUTTON', text: '赞同 7472' }] },
      { tag: 'SECTION', kids: [{ tag: 'BUTTON', text: '赞同 583' }] },
    ],
  };
  const hits = searchByText<N>(root, '赞同', ad);
  assert.equal(hits.length, 3);
  assert.ok(hits.every(h => h.tag === 'BUTTON'));
});

test('DROP 标签自身不匹配(子仍递归)', () => {
  // DROP 标签(SCRIPT/STYLE 等)自身文本不参与匹配,但其子节点仍递归搜。
  // 真实 DOM 里 SCRIPT/STYLE 的 .children 为空(内容是 text node),这里造伪结构
  // 验证"DROP 标签自身不命中,即使文本含关键词"。
  const drop = new Set(['SCRIPT', 'STYLE']);
  const root: N = {
    tag: 'BODY',
    kids: [
      { tag: 'SCRIPT', text: 'var x = "赞同"' },
      { tag: 'STYLE', text: '.a{content:"赞同"}' },
      { tag: 'BUTTON', text: '赞同' },
    ],
  };
  const hits = searchByText<N>(root, '赞同', ad, { dropTags: drop });
  // SCRIPT/STYLE 自身被 DROP 跳过,只剩顶层 BUTTON 命中
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, 'BUTTON');
});

test('visited 防环:节点被环状引用时不无限递归', () => {
  // a.kids = [b], b.kids = [a] —— 形成环。
  // 让 a/b 都不含关键词(避免"命中即止"提前 return,确保遍历真的撞环),环尾再挂一个命中节点。
  const a: N = { tag: 'DIV', kids: [] };
  const b: N = { tag: 'SPAN', kids: [] };
  a.kids!.push(b);
  b.kids!.push(a); // 环
  a.kids!.push({ tag: 'BUTTON', text: '赞同' }); // 环外挂一个命中
  const hits = searchByText<N>(a, '赞同', ad);
  // 不挂(visited 拦下环的二次进入),且最终命中那个环外的 BUTTON
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, 'BUTTON');
});

test('maxVisit 防爆炸:巨型子树到上限即停', () => {
  // 造一个超宽树:1 个根 + 100000 个叶子,每个叶子文本含关键词
  const leaves: N[] = [];
  for (let i = 0; i < 100000; i++) leaves.push({ tag: 'BUTTON', text: '赞同' });
  const root: N = { tag: 'BODY', kids: leaves };
  // 设 maxVisit=1000:命中即止,第 1 个叶子命中后 return 不深入其子,继续兄弟;
  // 但 visitedCount 涨到 1000(根 1 + 兄弟叶子遍历 999)就停。
  const hits = searchByText<N>(root, '赞同', ad, { maxVisit: 1000 });
  assert.ok(hits.length < 100000, 'maxVisit 应限制访问,不会全收 100000 个');
  assert.ok(hits.length >= 1, '至少命中 1 个');
});

test('默认 maxVisit 是个合理的上限值(覆盖现代 SPA,防百万级爆炸)', () => {
  // 不直接构造百万节点(太慢),只验证常量值在合理区间
  assert.ok(DEFAULT_MAX_VISIT >= 50000, '默认上限至少 5 万(覆盖大型 SPA)');
  assert.ok(DEFAULT_MAX_VISIT <= 1000000, '默认上限不超过 100 万(仍是爆炸保护)');
});

test('空 needle 返回空(不误命中所有"含空串"的元素)', () => {
  const root: N = { tag: 'BUTTON', text: '赞同' };
  assert.deepEqual(searchByText<N>(root, '', ad), []);
});

test('自身文本不含但子树含→不命中(用自身文本而非子树文本,才能命中具体元素)', () => {
  // 父 div 自身无文本(只在子有文本),不该命中;子 button 才命中
  const root: N = { tag: 'DIV', kids: [{ tag: 'BUTTON', text: '赞同' }] };
  const hits = searchByText<N>(root, '赞同', ad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, 'BUTTON');
});
