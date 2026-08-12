/**
 * redirect.test.ts — 跳转链接解码纯函数单测(浏览器侧 src/inject/lib/redirect.ts 的 decodeRedirectUrl)。
 * 覆盖:命中各跳转器、参数缺失/空、双重编码、非法 %、javascript: 拒绝、// 协议相对放行、密文/未知 host 原样返回。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRedirectUrl } from '../src/inject/lib/redirect.ts';

test('知乎跳转解回真实 URL(单层百分号编码)', () => {
  assert.equal(
    decodeRedirectUrl('https://link.zhihu.com/?target=https%3A%2F%2Fgithub.com%2Fcloudflare%2Fcloudflare-os'),
    'https://github.com/cloudflare/cloudflare-os',
  );
});

test('掘金跳转解回真实 URL', () => {
  assert.equal(
    decodeRedirectUrl('https://link.juejin.cn/?target=https%3A%2F%2Fcaniuse.com%2F'),
    'https://caniuse.com/',
  );
});

test('Facebook l.php 的 u 参数解回真实 URL(忽略 h/s/enc 等其他参数)', () => {
  assert.equal(
    decodeRedirectUrl('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fpage&h=AT0abc&s=1'),
    'https://example.com/page',
  );
});

test('Google /url 的 q 参数解回真实 URL', () => {
  assert.equal(
    decodeRedirectUrl('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc&sa=D'),
    'https://example.com/a?b=c',
  );
});

test('双重编码(再套一层 encodeURIComponent)最多解两轮到干净 URL', () => {
  assert.equal(
    decodeRedirectUrl('https://link.zhihu.com/?target=https%253A%252F%252Fexample.com%252Fx'),
    'https://example.com/x',
  );
});

test('参数缺失 → 原样返回', () => {
  const h = 'https://link.zhihu.com/';
  assert.equal(decodeRedirectUrl(h), h);
});

test('空值参数 → 原样返回', () => {
  const h = 'https://link.zhihu.com/?target=';
  assert.equal(decodeRedirectUrl(h), h);
});

test('非法百分号编码不抛异常 → 原样返回', () => {
  const h = 'https://link.zhihu.com/?target=%zz123';
  assert.equal(decodeRedirectUrl(h), h);
});

test('javascript: 协议目标 → 拒绝,原样返回', () => {
  const h = 'https://link.zhihu.com/?target=javascript%3Aalert(1)';
  assert.equal(decodeRedirectUrl(h), h);
});

test('// 协议相对目标 → 放行', () => {
  assert.equal(decodeRedirectUrl('https://link.zhihu.com/?target=%2F%2Fcdn.example.com%2Fx'), '//cdn.example.com/x');
});

test('未命中白名单 host → 原样返回', () => {
  const h = 'https://example.com/?target=https%3A%2F%2Ffoo.com';
  assert.equal(decodeRedirectUrl(h), h);
});

test('百度 link 密文 url 参数 → 不进入白名单,原样返回', () => {
  const h = 'https://www.baidu.com/link?url=abcdef0123456789abcdef';
  assert.equal(decodeRedirectUrl(h), h);
});

test('同 host 不同 path(非 /url)不误解 → 原样返回', () => {
  const h = 'https://www.google.com/search?q=https%3A%2F%2Fexample.com';
  assert.equal(decodeRedirectUrl(h), h);
});

test('空串/空白 → 原样返回', () => {
  assert.equal(decodeRedirectUrl(''), '');
});

test('非法整体 URL → 原样返回', () => {
  const h = 'not a url at all';
  assert.equal(decodeRedirectUrl(h), h);
});
