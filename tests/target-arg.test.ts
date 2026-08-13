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
  assert.match(String(selectorDialect('../button')), /XPath/); // 父轴
  assert.match(String(selectorDialect('(//button)[1]')), /XPath/); // 带位置过滤
  assert.match(String(selectorDialect('(.//button)[1]')), /XPath/);
  assert.throws(() => normArg('.//button'), /XPath/);
});

test('selectorDialect: 相对 XPath 的属性与轴语法也要认(不只 contains/text/@class)', () => {
  // 原先只认 @class 是不一致 —— 这些一样常见
  assert.match(String(selectorDialect("div[@id='x']")), /XPath/);
  assert.match(String(selectorDialect("*[@role='button']")), /XPath/);
  assert.match(String(selectorDialect("//a[@href='x']")), /XPath/);
  // XPath 位置谓词:CSS 属性名不能以数字开头,故 `[N]` 在语法位置必然不是 CSS(实测)
  assert.match(String(selectorDialect('//button[1]')), /XPath/);
  assert.match(String(selectorDialect('following-sibling::button[1]')), /XPath/);
  assert.match(String(selectorDialect('descendant::*')), /XPath/); // `::*` 实测 INVALID
});

test('selectorDialect: 裸轴表达式**刻意不判**——`X::Y` 本质不可判定', () => {
  // 真浏览器实测:`X::Y` 合不合法取决于 Y 是不是当前浏览器认识的伪元素,两侧都是开放集合:
  //   descendant::BEFORE / details-content / view-transition-group(x)  → VALID(合法 CSS)
  //   descendant::button / following-sibling::div                      → INVALID(真 XPath)
  // 纯 Node 侧没有 CSS parser,判不了。继续补名单会两个方向轮流漏,所以刻意退化:
  // 裸轴不诊断,交给 querySelector 报通用"只支持 CSS"。**退化可接受,误伤不可接受。**
  //
  // 这一侧(合法 CSS)必须放行 —— 回归的是这个:
  for (const sel of [
    'descendant::before',
    'descendant::BEFORE', // 伪元素名大小写不敏感
    'descendant::details-content', // 新增伪元素,名单必然跟不上
    'descendant::view-transition-group(x)',
    'self::part(name)',
    'parent::after',
  ]) {
    assert.equal(selectorDialect(sel), null, sel);
  }
  // 这一侧(真 XPath)刻意不判 —— 记录该取舍,改动时须同步更新注释与 PR 说明:
  for (const sel of ['descendant::button', 'following-sibling::button', 'preceding-sibling::div']) {
    assert.equal(selectorDialect(sel), null, `${sel}:裸轴刻意退化,不是遗漏`);
  }
  // 但只要**另有**无名单的 XPath 证据,仍然判得出来:
  assert.match(String(selectorDialect('//following-sibling::button')), /XPath/); // 路径根
  assert.match(String(selectorDialect('following-sibling::button[1]')), /XPath/); // 位置谓词
  assert.match(String(selectorDialect("descendant::*[@id='x']")), /XPath/); // 属性 + ::*
});

test('selectorDialect: 但 CSS 伪元素不能被轴规则误伤', () => {
  // 轴必须按名字白名单认;写成通用 `\w+::\w+` 会把这些合法 CSS 全吃掉
  for (const sel of ['div::before', 'p::first-line', 'input::placeholder', 'li::marker', '::selection']) {
    assert.equal(selectorDialect(sel), null, sel);
  }
  // 轴名本身也可能是元素名:真浏览器实测 `descendant::before` / `self::part(name)` / `parent::after`
  // parse 通过(合法 CSS),而 `descendant::button` / `self::div` 抛 SyntaxError(真 XPath)。
  // 所以分界是"`::` 后面跟的是不是伪元素",不是"前面是不是轴名"。
  // `@` 在引号/注释里仍是数据
  assert.equal(selectorDialect('[data-x="@id"]'), null);
  assert.equal(selectorDialect('a[href*="@class"]'), null);
  assert.equal(selectorDialect('div/* @id */ > p'), null);
});

test('selectorDialect: Playwright 显式引擎前缀也要认(不只 text=)', () => {
  assert.match(String(selectorDialect('css=button')), /Playwright/);
  assert.match(String(selectorDialect('id=submit')), /Playwright/);
  assert.match(String(selectorDialect('data-testid=save')), /Playwright/);
  assert.match(String(selectorDialect('role=button')), /Playwright/);
  // xpath= 必须仍报 XPath 而不是被通用前缀抢走
  assert.match(String(selectorDialect('xpath=//button')), /XPath/);
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
  // 通用引擎前缀只认「串首标识符紧跟 =」;属性判等写在 [] 里的合法 CSS 不受影响
  assert.equal(selectorDialect('div[data-x=y]'), null);
  assert.equal(selectorDialect('div:nth-child(1)'), null); // 括号里的数字不是 [N] 谓词
  assert.equal(selectorDialect('a[href="[1]"]'), null); // 引号里的 [1] 是数据
  assert.equal(selectorDialect('input[type=checkbox]:checked'), null);
  assert.equal(selectorDialect('a[href^="/x"] > span'), null);
  // 父轴形态不能误伤普通类选择器
  assert.equal(selectorDialect('.foo.bar'), null);
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
