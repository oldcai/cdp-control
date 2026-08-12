/**
 * tab-diff.test.ts — diffTabs 纯函数单测(零运行时依赖)。
 * 覆盖:无变化空 diff / 新开 / 关闭 / 同 id 跳转(navigated 只在有跳转时挂字段)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTabs } from '../src/tab-diff.ts';

test('diffTabs 无任何变化:全空,且不挂 navigated 字段', () => {
  const a = [{ id: 't1', url: 'https://a.com' }];
  const d = diffTabs(a, [{ id: 't1', url: 'https://a.com' }]);
  assert.deepEqual(d, { opened: [], closed: [] });
  assert.ok(!('navigated' in d), '无跳转时不应挂 navigated');
});

test('diffTabs 新开 tab 进 opened,关闭 tab 进 closed', () => {
  const before = [
    { id: 't1', url: 'https://a.com' },
    { id: 't2', url: 'https://b.com' },
  ];
  const after = [
    { id: 't1', url: 'https://a.com' },
    { id: 't3', url: 'https://c.com' },
  ];
  const d = diffTabs(before, after);
  assert.deepEqual(d.opened, [{ id: 't3', url: 'https://c.com' }]);
  assert.deepEqual(d.closed, [{ id: 't2', url: 'https://b.com' }]);
  assert.ok(!('navigated' in d));
});

test('diffTabs 同 id 跳转进 navigated,且只在有跳转时挂字段', () => {
  const before = [{ id: 't1', url: 'https://a.com/page1' }];
  const after = [{ id: 't1', url: 'https://a.com/page2' }];
  const d = diffTabs(before, after);
  assert.deepEqual(d, {
    opened: [],
    closed: [],
    navigated: [{ id: 't1', from: 'https://a.com/page1', to: 'https://a.com/page2' }],
  });
});

test('diffTabs 跳转 + 新开混在一起都报,navigated 仍挂', () => {
  const before = [{ id: 't1', url: 'https://a.com/old' }];
  const after = [
    { id: 't1', url: 'https://a.com/new' }, // 跳转
    { id: 't2', url: 'https://b.com' }, // 新开
  ];
  const d = diffTabs(before, after);
  assert.deepEqual(d.opened, [{ id: 't2', url: 'https://b.com' }]);
  assert.deepEqual(d.closed, []);
  assert.deepEqual(d.navigated, [{ id: 't1', from: 'https://a.com/old', to: 'https://a.com/new' }]);
});

test('diffTabs 跳转到空 url(about:blank 类):from 保留原值,仍算跳转', () => {
  const before = [{ id: 't1', url: 'https://a.com' }];
  const after = [{ id: 't1', url: 'about:blank' }];
  const d = diffTabs(before, after);
  assert.deepEqual(d.navigated, [{ id: 't1', from: 'https://a.com', to: 'about:blank' }]);
});
