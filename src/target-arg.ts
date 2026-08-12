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
/** 别的定位方言:XPath 与 Playwright/uBlock 写法。querySelector 只吃 CSS,原样丢进去只会抛裸 SyntaxError。 */
const DIALECTS: Array<[RegExp, string]> = [
  [/\bcontains\s*\(|\btext\s*\(\s*\)|^\s*\/\/|@class\b/, 'XPath'],
  [/:has-text\(|:text\(|>>|^text=/i, 'Playwright'],
];

/** 命中别的定位方言就报出"是哪种方言 + 该怎么写",否则返回 null。纯函数,单测覆盖。 */
export function selectorDialect(sel: string): string | null {
  for (const [re, name] of DIALECTS) if (re.test(sel)) return name;
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
      throw new Error(`操作目标是 ref 序号或 CSS selector,不是网址: ${a}\n打开网页用 cdp-control open <url>(或 navigate),再 view 拿 ref 去操作`);
    }
    const d = selectorDialect(a);
    if (d) {
      throw new Error(`selector 只支持 CSS,这条像是 ${d} 写法: ${a}\n按文本找元素用 cdp-control find --text "<关键词>",拿到 ref 再操作`);
    }
  }
  return typeof a === 'string' ? { sel: a } : a;
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
    throw new Error(`${cmd} 的位置参数是 view 输出的 ref 序号(纯数字),不是网址: ${s}\n打开网页: cdp-control open <url>;看已打开的页面: cdp-control ${cmd} --target <url或title子串>`);
  }
  throw new Error(`${cmd} 的位置参数是 view 输出的 ref 序号(纯数字),收到: ${s}`);
}
