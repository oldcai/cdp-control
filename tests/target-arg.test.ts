/**
 * target-arg.test.ts — 位置参数/操作目标的防呆单测(纯函数)。
 * 都是 2026-08 用弱模型跑真实任务时实测踩到的用法:
 *   `view <url>`(URL 当 ref 位置参)、`click "div[contains(@class,…)]"`(XPath 当 CSS)。
 * 这些以前要么被静默吞掉、要么只抛裸 SyntaxError,模型无法自我纠正。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normArg, parseRefArg, selectorDialect } from '../src/target-arg.ts';

test('normArg: 网址当操作目标 → 指向 open,别丢给 querySelector', () => {
  assert.throws(() => normArg('https://www.zhihu.com/question/1/answer/2'), /不是网址|open <url>/);
  assert.throws(() => normArg('//example.com/x'), /open <url>/);
  // 正常 CSS 里出现 http 字样不该误伤
  assert.deepEqual(normArg('a[href^="https://"]'), { sel: 'a[href^="https://"]' });
});

test('normArg: XPath / Playwright 方言 → 说清是哪种方言并指向 find --text', () => {
  assert.throws(() => normArg("div[contains(@class,'x')]"), /XPath/);
  assert.throws(() => normArg("//div[@id='a']"), /XPath/);
  assert.throws(() => normArg("button:has-text('阅读全文')"), /Playwright/);
  assert.throws(() => normArg('text=登录'), /Playwright/);
  assert.throws(() => normArg("div >> span"), /Playwright/);
  assert.match(String(selectorDialect("div[contains(text(),'x')]")), /XPath/);
  assert.equal(selectorDialect('#a .b > span:nth-of-type(2)'), null);
});

test('parseRefArg: 只吃纯数字;网址给出可执行的下一步;别的报清楚收到了啥', () => {
  assert.equal(parseRefArg('80'), 80);
  assert.equal(parseRefArg(undefined), undefined);
  assert.equal(parseRefArg(12), 12);
  assert.throws(() => parseRefArg('https://www.zhihu.com/x', 'view'), /view 的位置参数是.*ref 序号.*不是网址[\s\S]*open <url>/);
  assert.throws(() => parseRefArg('.some-class', 'article'), /article 的位置参数是.*收到: \.some-class/);
  assert.throws(() => parseRefArg('12abc'), /收到: 12abc/);
});
