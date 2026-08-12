/**
 * ignore-links.test.ts — 链接黑名单纯函数单测:Node 侧(src/ignore-links.ts)的
 * hrefForMatch/globToRegExp/linkRuleMatch/parseLinkRules(读取链;写操作 addLinkRule/removeLinkRule 已随规则管理命令移除);
 * 浏览器侧(src/inject/lib/ignore-links.ts)的 linkIgnored(view/article 共用)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hrefForMatch, linkRuleMatch, parseLinkRules } from '../src/ignore-links.ts';
import { globToRegExp } from '../src/url-scope.ts';
import { linkIgnored } from '../src/inject/lib/ignore-links.ts';

test('hrefForMatch: 去协议/query/fragment,留 hostname+pathname', () => {
  assert.equal(hrefForMatch('https://zhida.zhihu.com/search?content_id=1&q=x#f'), 'zhida.zhihu.com/search');
  assert.equal(hrefForMatch('http://a.com/x/y?z=1'), 'a.com/x/y');
});

test('hrefForMatch: 非法 URL 返回原串', () => {
  assert.equal(hrefForMatch('not-a-url'), 'not-a-url');
});

test('globToRegExp: * 匹配任意字符(含 /)', () => {
  assert.equal(globToRegExp('zhida.zhihu.com/search*').test('zhida.zhihu.com/search'), true);
  assert.equal(globToRegExp('zhida.zhihu.com/search*').test('zhida.zhihu.com/search/extra'), true);
  assert.equal(globToRegExp('*.zhihu.com/*').test('www.zhihu.com/question/x'), true);
  assert.equal(globToRegExp('*.zhihu.com/*').test('baidu.com/x'), false);
});

test('linkRuleMatch: 空 pattern 全命中;非空 glob 命中 hrefForMatch', () => {
  assert.equal(linkRuleMatch({ id: 1, pattern: '', note: '' }, 'https://anything.com/x'), true);
  assert.equal(
    linkRuleMatch({ id: 1, pattern: 'zhida.zhihu.com/search*', note: '' }, 'https://zhida.zhihu.com/search?q=词'),
    true,
  );
  assert.equal(linkRuleMatch({ id: 1, pattern: 'zhida.zhihu.com/search*', note: '' }, 'https://example.com/x'), false);
});

test('parseLinkRules: 3 列 id/pattern/note,注释与垃圾行跳过', () => {
  const txt = '# 注释\n\n1\tzhida.zhihu.com/search*\t知乎词\nnotnum\ta\tb\n2\t*.x.com/*\t\n';
  const r = parseLinkRules(txt);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { id: 1, pattern: 'zhida.zhihu.com/search*', note: '知乎词' });
  assert.deepEqual(r[1], { id: 2, pattern: '*.x.com/*', note: '' });
});

test('linkIgnored(浏览器侧):空模式数组不命中;glob 匹配 hostname+pathname', () => {
  assert.equal(linkIgnored(undefined, 'https://a.com/x'), false);
  assert.equal(linkIgnored([], 'https://a.com/x'), false);
  assert.equal(linkIgnored(['zhida.zhihu.com/search*'], 'https://zhida.zhihu.com/search?content_id=1&q=词'), true);
  assert.equal(linkIgnored(['zhida.zhihu.com/search*'], 'https://www.baidu.com/x'), false);
  assert.equal(linkIgnored(['*.zhihu.com/*'], 'https://www.zhihu.com/question/1'), true);
  assert.equal(linkIgnored([''], 'https://anything.com'), true); // 空 pattern = 全命中
});
