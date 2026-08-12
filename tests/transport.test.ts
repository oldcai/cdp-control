/**
 * transport.test.ts — resolveTarget 纯函数单测(Node 内置 node:test,零依赖)。
 * 覆盖空列表抛错、无 match 选普通网页、精确 id、url/title 子串、DevTools 排除。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, type Target } from '../src/transport.ts';

const list: Target[] = [
  { id: 'aaa111', url: 'devtools://devtools/bundled/inspector.html', title: 'DevTools' },
  { id: 'bbb222', url: 'https://example.com', title: '示例站' },
  { id: 'ccc333', url: 'about:blank', title: 'New Tab' },
];

test('空列表抛错', () => {
  assert.throws(() => resolveTarget([]), /没有可用的 page tab/);
});

test('无 match 跳过 devtools/about/edge/chrome 选第一个普通网页', () => {
  const t = resolveTarget(list, undefined);
  assert.equal(t.id, 'bbb222');
});

test('精确 id 匹配', () => {
  assert.equal(resolveTarget(list, 'ccc333').id, 'ccc333');
});

test('url 子串匹配', () => {
  assert.equal(resolveTarget(list, 'example.com').id, 'bbb222');
});

test('title 子串匹配', () => {
  assert.equal(resolveTarget(list, '示例').id, 'bbb222');
});

test('匹配不到抛错并列出可选', () => {
  assert.throws(() => resolveTarget(list, 'nonexistent'), /没有找到匹配/);
});
