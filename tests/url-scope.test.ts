/**
 * url-scope.test.ts — 共享 URL 作用域匹配工具(globToRegExp/hostOf/pathOf/urlMatches)纯函数单测。
 * 消重复后唯一权威实现;fold(folds.ts)用它拆 hostname+pathname 两维,ignore-links(ignore-links.ts)用它做拼接串 glob,
 * recipe 作用域分发(recipe-runner.ts)用它 urlMatches 命中。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, hostOf, pathOf, urlMatches } from '../src/url-scope.ts';

test('globToRegExp: 通配 + 字面转义 + 两端锚定', () => {
  const star = globToRegExp('*.zhihu.com/search*');
  assert.ok(star.test('a.zhihu.com/search')); // * 匹配任意字符含 /
  assert.ok(star.test('b.zhihu.com/search/q/123')); // 中间 * 匹配多段
  assert.ok(!star.test('zhihu.com/search')); // 前导 * 需要子域段?—— 见下:开头 *. 需匹配完整段
  assert.ok(!star.test('x.example.com/search')); // 字面不匹配
  assert.ok(!star.test('a.zhihu.com/other')); // 尾部锚定
  // 字面特殊字符转义
  const esc = globToRegExp('zhida.zhihu.com/search*');
  assert.ok(esc.test('zhida.zhihu.com/search?x=1&y=2'));
  assert.ok(!esc.test('zhida.zhihu.com/other'));
  assert.ok(!esc.test('zzhida.zhihu.com/search')); // 前导锚定(开头精确)
});

test('hostOf/pathOf: 提取 hostname/pathname;非法与 about:blank 返回空', () => {
  assert.equal(hostOf('https://www.zhihu.com/question/1'), 'www.zhihu.com');
  assert.equal(pathOf('https://www.zhihu.com/question/1'), '/question/1');
  assert.equal(hostOf('about:blank'), '');
  assert.equal(pathOf('about:blank'), '');
  assert.equal(hostOf(''), '');
  assert.equal(pathOf('not a url'), '');
});

test('urlMatches: 作用域 glob 匹配 hostname+pathname 拼接串;无 hostname 不命中', () => {
  assert.ok(urlMatches('www.zhihu.com/question/*', 'https://www.zhihu.com/question/1950/answer/2000'));
  assert.ok(!urlMatches('www.zhihu.com/question/*', 'https://www.zhihu.com/topic/1'));
  assert.ok(!urlMatches('www.zhihu.com/question/*', 'https://other.com/question/1'));
  assert.ok(urlMatches('*.zhihu.com/*', 'https://www.zhihu.com/x'));
  assert.ok(urlMatches('zhihu.com/*', 'https://zhihu.com/a/b')); // hostname 不含 www 时精确
  assert.ok(!urlMatches('www.zhihu.com/question/*', 'about:blank')); // 无 hostname → 不命中
});
