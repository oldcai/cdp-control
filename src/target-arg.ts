/**
 * target-arg.ts — 操作目标参数归一化(纯函数,零运行时依赖,可单测)。
 *
 * 抽离自 api.ts:click/fill/focus/hover 的目标参数可能是 selector 字符串或 {ref,ancestor?} 对象,
 * normArg 把它们归一化为注入侧 {sel?}/{ref?} 形态。防呆逻辑也在此(字符串形态的 "{ref:N}" 抛友好错误)。
 *
 * 为什么独立模块:normArg 是纯函数,而 api.ts 顶部 import 一堆运行时模块(transport/monitor/folds),
 * 直接 import api.ts 做单测会拽出整条 Node 侧依赖链(且源码无扩展名 import 在 --experimental-strip-types
 * 下解析失败)。抽成独立模块让单测零依赖、聚焦防呆正则。
 */

/** 操作目标:selector 字符串,或 {ref:n, ancestor?} 用 view 登记的引用序号(穿透 shadow,可选爬父)。 */
export type TargetArg = string | { ref: number; ancestor?: number };

/** 字符串形态的 \"{ref:N}\" 防呆正则:CLI 误用对象字面量当 selector(querySelector 会抛原生 CSS 异常)。 */
const RE_REF_LITERAL = /^\{[\s\S]*ref[\s\S]*\}$/;
/**
 * 网址防呆:URL 只进 open/navigate/fetch,不进 ref 位、也不当 selector。
 * 协议相对写法(`//host/path`)要求首段像域名 —— 否则会误伤 XPath 的 `//div[@id=x]`。
 */
const RE_URL = /^(https?:\/\/|\/\/[\w-]+(\.[\w-]+)+([/?#]|$))/i;
/**
 * 整串形状类方言:锚在串首,判的是"这条压根不是 CSS",不是某个 token。
 * 必须看**原串** —— 掩码会动串首(`//*[…]` 的 `/*` 长得像 CSS 注释开头),
 * 放到掩码后判会把 XPath 漏掉。合法 CSS selector 不可能以这些形状开头,所以原串判是安全的。
 */
const SHAPES: Array<[RegExp, string]> = [
  // XPath 路径根:绝对 `/html/body/div`、`//div[…]`;相对 `./div`、`.//button`、`../button`;
  // 带位置过滤的 `(//button)[1]`、`(.//button)[1]`。
  // 两个必须放行的合法 CSS 长得很像,都靠这条正则的细节挡住:
  //  - `/* c */ div` —— 注释可以打头,故 `(?!\*)` 排除 `/*`;
  //  - `.\/foo`      —— 类名真叫 `/foo`,`.` 后面是 `\` 不是 `/`,天然不匹配。
  [/^\s*\(*\s*\.{0,2}\/(?!\*)/, 'XPath'],
  // `xpath=` 要排在下面的通用引擎前缀之前,否则会被报成 Playwright 而不是 XPath。
  [/^\s*xpath\s*=/i, 'XPath'],
  // Playwright 显式引擎前缀:`text=登录`、`css=button`、`id=submit`、`data-testid=save`、`role=…`。
  // 合法 CSS selector 不可能以「标识符 =」开头(属性判等要写在 `[]` 里),所以这条前缀判是安全的:
  // `svg text[x="1"]`(`text` 是合法 SVG 元素名)、`div[data-x=y]` 都不匹配 —— 标识符后面不是 `=`。
  [/^\s*[\w-]+\s*=/, 'Playwright'],
];
/**
 * token 类方言:XPath 与 Playwright/uBlock 写法。querySelector 只吃 CSS,原样丢进去只会抛裸 SyntaxError。
 * 这些判在掩码后的残留串上 —— 引号/注释里的同名字样是数据,不是语法。
 */
/**
 * token 判据的共同要求:**在掩码后的语法位置上出现就不可能是合法 CSS**。
 * 判"这不可能是 CSS"(规则少而稳),而不是判"这看起来像 XPath"(开放集合,永远补不完)。
 *
 * 为什么这里没有"轴"规则 —— 这是被实测推翻后的刻意删除,别再加回来:
 *   曾经按 `轴名::` 判 XPath,于是需要一份 CSS 伪元素名单来排除 `descendant::before`。
 *   真浏览器实测证明这条路走不通,**两侧都是开放集合**:
 *     `descendant::BEFORE`               → VALID(伪元素名大小写不敏感)
 *     `descendant::details-content`      → VALID(伪元素随浏览器演进新增)
 *     `descendant::view-transition-group(x)` → VALID(带参数形态)
 *     `descendant::-moz-anything`        → Chrome 里 INVALID(厂商前缀还因浏览器而异)
 *   而另一侧 `descendant::button` / `following-sibling::div` 确实 INVALID。
 *   也就是说 `X::Y` 到底合不合法**取决于 Y 是不是当前浏览器认识的伪元素** ——
 *   纯 Node 侧没有 CSS parser,这件事**本质不可判定**。
 *   继续补名单只会两个方向轮流漏(漏放真 XPath / 误拒合法 CSS),已实测各漏 2 例。
 *
 * 取舍(明确记录):裸轴表达式(`following-sibling::button`)不再被诊断为 XPath,
 * 退化成 querySelector 的通用"只支持 CSS"报错。**退化可接受,误伤不可接受** ——
 * 误拒合法 CSS 是真实回归,漏诊断只是少一句指路。
 * 带路径根(`//descendant::button`)、带谓词(`following-sibling::button[1]`)、
 * 带属性(`descendant::*[@id='x']`)的形态仍被下面的无名单判据覆盖。
 */
const DIALECTS: Array<[RegExp, string]> = [
  [
    // `contains(` / `text()`:CSS 没有同名函数。
    // `@ident`:CSS 里 `@` 只能起 at-rule,绝不出现在 selector 语法位置。
    // `[N]`:XPath 位置谓词。实测 `div[1]` / `button[1]` / `[1]` 全部 INVALID,
    //        而 `div[data-x]` / `div:nth-child(1)` VALID —— CSS 属性名不能以数字开头。
    // `::*`:实测 INVALID(没有 `::*` 这个伪元素)。
    // 以上四条都**不依赖任何名单**,不会随浏览器演进漂移。
    /\bcontains\s*\(|\btext\s*\(\s*\)|@[a-zA-Z_][\w.-]*|\[\s*\d+\s*\]|::\*/,
    'XPath',
  ],
  [/:has-text\(|:text\(|>>/i, 'Playwright'],
];
/**
 * 本工具自定义的 shadow 穿透链分隔符:locate 对 shadow 内元素输出 `hostSel >>> seg`,
 * 但只有 view --selector-file / find --selector 走 findRoot 解析它;
 * click/fill/focus/hover 是裸 document.querySelector,不认。
 * 必须在方言判定**之前**认领:否则 Playwright 的 `>>` 会抢先命中,
 * 把本工具自己的输出诊断成"像是 Playwright 写法"并指向 find --text —— 错的诊断比没诊断更坑。
 */
const RE_SHADOW_CHAIN = />>>/;

/**
 * 掩码占位符。选它有两条硬要求,少一条就会凭空造出假方言:
 *  - 不能是词字符:否则会并进相邻标识符,改变 `\b` 边界;
 *  - 不能是空白:否则会给 `\bcontains\s*\(` 这类带 `\s*` 的模式搭桥。
 * NUL 两条都满足,且不可能出现在人手写的 selector 里。
 */
const MASK = '\0';

/**
 * 掩掉 CSS 里"是数据不是语法"的部分(字符串字面量内容、转义序列、注释),
 * 只留结构位置的 token,供方言判定使用。
 *
 * 为什么必须掩码:`input[value="text()"]`、`a[href*="contains("]`、`[aria-label="a >> b"]`、
 * `div/* contains( *\/ > span` 都是合法 CSS,方言字样只是属性值/注释里的**数据**。
 * 直接拿原串做正则匹配,这些选择器会在到达 querySelector 之前就被防呆拒掉(2026-08 实测回归)。
 *
 * 三条不变量:
 *  1. **换占位符,不删**。删掉会让两侧 token 贴到一起、凭空拼出假方言 ——
 *     `div >\x> span` 等价于 `div > x > span`,把 `\x` 删掉就成了 `div >> span`。
 *  2. **引号分隔符保留**。残留串里 `"` 仍是非词字符,`\b` 语义不变,
 *     所以紧贴引号的真方言(`[@class="a" and contains(text(),"b")]`)不会丢边界。
 *  3. **只处理引号外的注释**。`[data-x="/*"]` 里的 `/*` 是数据。
 *
 * 未闭合的引号/注释:其后整体按字面量吞掉。这种半截串本就不是合法 CSS,
 * 由注入侧 findTarget 的 querySelector catch 报"只支持 CSS",防呆不落空。
 *
 * 注意:串首形状类方言(`//…`、`text=…`)不能在这里判 —— 见 SHAPES。
 */
function stripCssLiterals(sel: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (quote) {
      // 串内转义(`"x\"y"`):整对都是数据,一并丢掉 —— 关键是别让 \" 提前闭合引号。
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) {
        out += c;
        quote = null;
      }
      continue;
    }
    // 串外 CSS 转义:`.a\>\>b` 的类名真叫 `a>>b`;`\x` 是把 x 当类型选择器写。
    // 这里必须留占位符 —— 删掉会让两侧 token 贴到一起(见上方不变量 1)。
    if (c === '\\') {
      out += MASK;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    // CSS 注释:浏览器在 tokenize 阶段就丢掉,内容不是语法。
    if (c === '/' && sel[i + 1] === '*') {
      const end = sel.indexOf('*/', i + 2);
      out += MASK;
      if (end === -1) return out; // 未闭合:其后整体是注释
      i = end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 命中别的定位方言就报出"是哪种方言 + 该怎么写",否则返回 null。纯函数,单测覆盖。
 * 两段判定:先看原串的整串形状(SHAPES),再看掩码残留串上的 token(DIALECTS)。
 * 顺序不能反 —— `//*[…]` 的 `/*` 会被掩码当成 CSS 注释开头吃掉,先判形状才不漏。
 */
export function selectorDialect(sel: string): string | null {
  for (const [re, name] of SHAPES) if (re.test(sel)) return name;
  const bare = stripCssLiterals(sel);
  for (const [re, name] of DIALECTS) if (re.test(bare)) return name;
  return null;
}

/**
 * 归一化操作目标为注入侧参数:字符串→{sel},对象→{ref}。
 * 防呆(三类,都是实测被弱模型踩过的):
 *  - \"{ref:80}\":对象字面量当 selector 字符串误用(CLI 应传数字 80)。
 *  - URL:把网址当操作目标(该用 open/navigate 打开页面,再按 ref/CSS 操作)。
 *  - XPath / Playwright 方言:querySelector 只吃 CSS,原样丢进去只抛裸 SyntaxError,模型看不懂会原地重试。
 */
export function normArg(a: TargetArg): { sel?: string; ref?: number } {
  if (typeof a === 'string') {
    if (RE_REF_LITERAL.test(a)) {
      throw new Error('CLI 直接传数字(如 80),脚本 API 才用 {ref:N};你传的是对象字面量字符串: ' + a);
    }
    // 顺序有讲究:`//x` 既可能是协议相对 URL 也可能是 XPath。RE_URL 要求 `//` 后面是带点的域名,
    // 先判它 → `//example.com/x` 归 URL、`//div[@id=x]` 落到下面的方言判定。
    if (RE_URL.test(a.trim())) {
      throw new Error(
        `操作目标是 ref 序号或 CSS selector,不是网址: ${a}\n打开网页用 cdp-control open <url>(或 navigate),再 view 拿 ref 去操作`,
      );
    }
    if (RE_SHADOW_CHAIN.test(stripCssLiterals(a))) {
      throw new Error(
        `shadow 链(a >>> b)只有 view --selector-file / find --selector 解析,操作命令不认: ${a}\n先 cdp-control find --selector "${a}" 拿到 [ref=N],再用 ref 操作`,
      );
    }
    const d = selectorDialect(a);
    if (d) {
      throw new Error(
        `selector 只支持 CSS,这条像是 ${d} 写法: ${a}\n按文本找元素用 cdp-control find --text "<关键词>",拿到 ref 再操作`,
      );
    }
  }
  return typeof a === 'string' ? { sel: a } : a;
}

/**
 * 只校验、不改形态:让 CLI 能在 `await needTarget(...)` **之前**引爆防呆。
 *
 * 为什么需要它:实参从左到右求值,`api.click(await needTarget(...), arg, …)` 会先解析浏览器目标,
 * 而防呆藏在 api 内部的 normArg 里。于是浏览器没起 / --target 无效时,
 * "这是 XPath 不是 CSS"之类的指路提示被端点错误盖掉,非法命令还会白白冷启动浏览器、
 * 甚至先装上 feedback observer。normArg 是纯函数,提前调一次只为它的抛出,重复调用无副作用。
 */
export function assertTargetArg(a: TargetArg): void {
  normArg(a);
}

/**
 * 位置参数 → ref 序号。位置参数一律是 view 输出的 ref(纯数字);传别的直接抛。
 * 为什么必须抛:`Number('https://…')` 是 NaN,旧代码把它当"没传"→ 静默给整页树,
 * 模型会以为自己已经在目标页上(2026-08 实测:弱模型全程在首页打转,还以为在目标回答页)。
 */
export function parseRefArg(n: string | number | undefined, cmd = 'view'): number | undefined {
  if (n == null) return undefined;
  const s = String(n).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (RE_URL.test(s)) {
    throw new Error(
      `${cmd} 的位置参数是 view 输出的 ref 序号(纯数字),不是网址: ${s}\n打开网页: cdp-control open <url>;看已打开的页面: cdp-control ${cmd} --target <url或title子串>`,
    );
  }
  throw new Error(`${cmd} 的位置参数是 view 输出的 ref 序号(纯数字),收到: ${s}`);
}
