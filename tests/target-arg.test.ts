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
  assert.throws(() => normArg('div >> span'), /Playwright/);
  assert.match(String(selectorDialect("div[contains(text(),'x')]")), /XPath/);
  assert.equal(selectorDialect('#a .b > span:nth-of-type(2)'), null);
});

test('selectorDialect: 引号里的 text()/contains(/>> 是数据不是语法,合法 CSS 必须放行', () => {
  // 2026-08 回归:方言正则未掩码字符串字面量,凡属性值里含这些子串的合法 CSS 都被拒在 querySelector 之前。
  assert.equal(selectorDialect('input[value="text()"]'), null);
  assert.equal(selectorDialect('a[href*="contains("]'), null);
  assert.equal(selectorDialect('[aria-label="a >> b"]'), null);
  // 单引号、@class 同理;转义写法(类名真叫 a>>b)也不该误判
  assert.equal(selectorDialect("input[value='text()']"), null);
  assert.equal(selectorDialect('[data-x="@class"]'), null);
  assert.equal(selectorDialect('.a\\>\\>b'), null);
  assert.equal(selectorDialect('div.foo > span'), null);
});

test('normArg: 上述合法 CSS 原样归一化为 {sel},不抛', () => {
  assert.deepEqual(normArg('input[value="text()"]'), { sel: 'input[value="text()"]' });
  assert.deepEqual(normArg('a[href*="contains("]'), { sel: 'a[href*="contains("]' });
  assert.deepEqual(normArg('[aria-label="a >> b"]'), { sel: '[aria-label="a >> b"]' });
});

test('selectorDialect: 掩码后真方言仍然全部拦下(防呆初衷不能丢)', () => {
  assert.match(String(selectorDialect('//div[@id=x]')), /XPath/);
  assert.match(String(selectorDialect('//*[contains(@class,"x")]')), /XPath/);
  assert.match(String(selectorDialect(':has-text(hi)')), /Playwright/);
  assert.match(String(selectorDialect('text=登录')), /Playwright/);
  // 字符串紧贴真方言 token 时也不能被掩码"吃掉"边界
  assert.match(String(selectorDialect('//*[@class="a" and contains(text(),"b")]')), /XPath/);
});

test('selectorDialect: 掩码要换占位符而不是删掉,否则两侧 token 会贴出假方言', () => {
  // `\x` 是把 x 当类型选择器写,`div >\x> span` 等价于 `div > x > span`(合法 CSS)。
  // 把转义整段删掉就成了 `div >> span`,会被误判 Playwright。
  assert.equal(selectorDialect('div >\\x> span'), null);
  assert.deepEqual(normArg('div >\\x> span'), { sel: 'div >\\x> span' });
  // 类名真叫 a>>b 的写法同理
  assert.equal(selectorDialect('.a\\>\\>b'), null);
  // 串内转义不能让 \" 提前闭合引号 —— 否则后面的内容会被当成语法位置
  assert.equal(selectorDialect('a[href="x\\"y"]'), null);
  assert.equal(selectorDialect('a[href="x\\">> "]'), null);
  assert.equal(selectorDialect("a[href='it\\'s >> x']"), null);
});

test('selectorDialect: CSS 注释是被 tokenizer 丢掉的文本,不是语法', () => {
  assert.equal(selectorDialect('div/* contains( */ > span'), null);
  assert.equal(selectorDialect('div/* text() */ > span'), null);
  assert.equal(selectorDialect('div/* @class */ > span'), null);
  assert.deepEqual(normArg('div/* >>> */ span'), { sel: 'div/* >>> */ span' }); // 注释里的 >>> 不是 shadow 链
  // 引号里的 `/*` 是数据,不能当注释开头吞掉后面
  assert.equal(selectorDialect('[data-x="/*"] > span'), null);
  // 注释未闭合(半截串)不当方言 —— 交给 querySelector 报错
  assert.equal(selectorDialect('div/* 没闭合'), null);
});

test('selectorDialect: 串首形状必须先于掩码判,`//*[…]` 的 /* 别被当成注释吃掉', () => {
  // 这条是上面两个修复的交互陷阱:先掩码再判,`//*[...]` 会被 CSS 注释分支吞成 `/`,XPath 漏判。
  assert.match(String(selectorDialect('//*[contains(@class,"x")]')), /XPath/);
  assert.match(String(selectorDialect('//*')), /XPath/);
  assert.match(String(selectorDialect('  //div[@id=x]')), /XPath/);
  assert.match(String(selectorDialect('text=登录')), /Playwright/);
});

test('selectorDialect: XPath 的其余根形态也要拦(绝对/相对/引擎前缀)', () => {
  assert.match(String(selectorDialect('/html/body/div')), /XPath/); // 绝对路径
  assert.match(String(selectorDialect('.//button')), /XPath/); // 相对路径
  assert.match(String(selectorDialect('./div')), /XPath/);
  assert.match(String(selectorDialect('xpath=//button')), /XPath/); // 引擎前缀
  assert.match(String(selectorDialect('XPath = //button')), /XPath/);
  assert.throws(() => normArg('.//button'), /XPath/);
});

test('selectorDialect: 但以 / 或 . 开头的合法 CSS 不能被上一条误伤', () => {
  // 注释可以打头 —— `/*` 不是 XPath 根
  assert.equal(selectorDialect('/* c */ div'), null);
  assert.deepEqual(normArg('/* c */ div'), { sel: '/* c */ div' });
  // 类名真叫 `/foo` 时写作 `.\/foo`,`.` 后面是 `\` 不是 `/`
  assert.equal(selectorDialect('.\\/foo'), null);
  // 普通类选择器不受影响
  assert.equal(selectorDialect('.foo'), null);
  assert.equal(selectorDialect('.foo > .bar'), null);
  // `text` 是合法 SVG 元素名,只有紧跟 `=` 才算 Playwright
  assert.equal(selectorDialect('text'), null);
  assert.equal(selectorDialect('svg text[x="1"]'), null);
});

test('normArg: `>>>` 是本工具自己的 shadow 链,要给对诊断而不是"像 Playwright"', () => {
  // locate 对 shadow 内元素输出 `hostSel >>> seg`;操作命令走裸 querySelector 不认它。
  // 若落到方言判定,Playwright 的 `>>` 会抢先命中,把本工具的输出诊断成别家方言 + 指错下一步。
  const msg = (() => {
    try {
      normArg('my-app >>> .btn');
      return '';
    } catch (e) {
      return String((e as Error).message);
    }
  })();
  assert.match(msg, /shadow 链/);
  assert.match(msg, /find --selector/); // 指对下一步
  assert.doesNotMatch(msg, /Playwright/); // 不能误诊成别家方言
  // 引号里的 `>>>` 仍是数据,不当 shadow 链
  assert.deepEqual(normArg('[aria-label="a >>> b"]'), { sel: '[aria-label="a >>> b"]' });
});

test('parseRefArg: 只吃纯数字;网址给出可执行的下一步;别的报清楚收到了啥', () => {
  assert.equal(parseRefArg('80'), 80);
  assert.equal(parseRefArg(undefined), undefined);
  assert.equal(parseRefArg(12), 12);
  assert.throws(
    () => parseRefArg('https://www.zhihu.com/x', 'view'),
    /view 的位置参数是.*ref 序号.*不是网址[\s\S]*open <url>/,
  );
  assert.throws(() => parseRefArg('.some-class', 'article'), /article 的位置参数是.*收到: \.some-class/);
  assert.throws(() => parseRefArg('12abc'), /收到: 12abc/);
});
