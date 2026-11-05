/**
 * find-goal-fixtures.test.ts — 离线校验评测数据:每条有解目标的金标都能命中真实元素,且树里没有输入框的值。
 * 只读文件,不访问 API(真实评测见 scripts/eval-find-goal.ts)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goldRefs, loadGoals, loadTree } from '../scripts/eval-find-goal.ts';
import { parseElements, elementsState } from '../src/find-goal.ts';

const goals = loadGoals();

test('评测数据: 49 条目标,39 条有解、10 条无解', () => {
  assert.equal(goals.length, 49);
  assert.equal(goals.filter(g => g.gold).length, 39);
});

test('评测数据: 每条有解目标的金标在页面上至少命中一个元素', () => {
  for (const g of goals) {
    if (!g.gold) continue;
    assert.ok(goldRefs(loadTree(g.page), g.gold).size > 0, `${g.page}: ${g.goal}`);
  }
});

test('评测数据: 发给 Jev 的 state 不含输入框的值,元素数够触发两阶段', () => {
  const pages = new Set(goals.map(g => g.page));
  for (const p of pages) assert.ok(!/\b(input|textarea)\[[^\]]*value="/.test(elementsState(parseElements(loadTree(p)))), p);
  assert.ok(parseElements(loadTree('stripe')).length > 1000);
});
