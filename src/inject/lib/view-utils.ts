/**
 * view-utils.ts — 结构视图输出的纯函数(无 DOM 依赖,可在 Node 里单测)。
 * 从旧 scripts.js buildViewExpr 的 inline 逻辑抽出,语义不变。
 */

/** 节点文本总长(递归求和,超阈值提前停,只判"够不够短")。 */
export function inlineLen(n: { text?: string; imgAlt?: string; leafValue?: string; kids?: any[] }): number {
  if (n.text) return n.text.length;
  if (n.imgAlt) return 2;
  if (n.leafValue) return n.leafValue.length + firstTxt(n.kids ?? []).length;
  let sum = 0;
  for (const k of n.kids ?? []) {
    sum += inlineLen(k);
    if (sum > 24) return sum;
  }
  return sum;
}

/** 是否内联短项(可视文本总长 >0 且 ≤24)。 */
export function inlineable(n: { text?: string; imgAlt?: string; leafValue?: string; kids?: any[] }): boolean {
  const l = inlineLen(n);
  return l > 0 && l <= 24;
}

/** 取节点可视文本(自身或首个有文本后代)。
 *
 * fold 节点(text=''、kids=[])视作有文本——返回其 fold 备注。这让包装 fold 的中间容器
 * 不被 isTrivialLeaf 误判为琐碎叶(否则 productive filter 会滤掉它,fold 节点永远走不到 walk)。 */
export function leafText(n: { text?: string; imgAlt?: string; fold?: string; kids?: any[] }): string {
  if (n.text) return n.text;
  if (n.fold) return n.fold;
  for (const k of n.kids ?? []) {
    const t = leafText(k);
    if (t) return t;
  }
  return '';
}

/** 取后代里第一个有文本的节点的文本(用于 title 自含项拼数值)。 */
export function firstTxt(arr: any[]): string {
  for (const k of arr) {
    if (k.text) return k.text;
    const t = firstTxt(k.kids ?? []);
    if (t) return t;
  }
  return '';
}

/** 琐碎叶子:空文本,或纯符号短串(如 "/"、"·" 分隔装饰)。 */
export function isTrivialLeaf(n: { text?: string; kids?: any[] }): boolean {
  const t = leafText(n).trim();
  if (!t) return true;
  return t.length <= 2 && /^[^\w一-龥]+$/.test(t);
}

/** 截断:maxLen 缺省/不足时不截;超长时截到 maxLen 并补省略号。
 * 默认不截断(view 全量输出),设阈值才强制截断——截断补 "…" 让完整文本与截断文本可区分。 */
export const cut = (text: string, maxLen?: number): string =>
  maxLen == null || text.length <= maxLen ? text : text.slice(0, maxLen) + '…';

/** 纯计数文本(如 "3"、"1.2万"、"548"):交互元素直接文本只剩计数、不带语义。
 * 此时需借 aria/title 补语义(见 view-core 的纯计数合并),否则 agent 只见裸数字,
 * 把收藏数/浏览数误当评论数(知乎收藏按钮直接文本即纯计数、语义在 aria-label="收藏")。 */
export const isPureCount = (text: string): boolean => /^[\d,，．.]+(?:万|亿|千|[kKmM])?$/.test(text.trim());

/** data-* 属性值是否像"语义锚点":按**值内容**识别,而非属性名白名单。
 * 不同站点把语义放进五花八门的 data-*(data-tooltip/data-testid/data-qa/data-role/...),白名单永远追不全;
 * 值长得像可读语义(短、非 JSON 埋点、非 url 编码、非哈希)就采。info 据此自动抓语义 data-*。 */
export const isSemanticDataValue = (value: string): boolean => {
  const s = value.trim();
  if (!s) return false;
  if (s.length > 80) return false; // 超长:埋点 JSON / 哈希 / 长 url,非锚点
  if (/^[\[\{]/.test(s)) return false; // JSON 数组/对象埋点(如知乎 data-za-extra-module)
  if (/%[0-9A-Fa-f]{2}/.test(s)) return false; // url 编码串(如 %20),非可读语义
  return true;
};
