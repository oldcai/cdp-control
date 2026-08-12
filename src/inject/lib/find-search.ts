/**
 * find-search.ts — find --text 的纯遍历逻辑(无 DOM 依赖,可单测)。
 *
 * 抽自 find-entry,目的:把"DFS 穿透 shadow 搜文本命中"的遍历/上限控制逻辑与 DOM 解耦,
 * 让"深链能命中 + 节点数上限防爆炸"这两个核心保证可在 Node 单测里验证。
 *
 * 设计:
 *   - 不设硬深度上限(现代 SPA 动辄 20+ 层 div 嵌套,硬深度会漏深层元素)。
 *   - 用访问节点数上限(MAX_VISIT)防极端爆炸(深层 shadow 嵌套、巨型列表)。
 *   - visited Set 防环 / 防 shadow 重入。
 *   - 命中即止:不在命中元素自身的子树里继续找(自身文本命中的是最具体元素,子树里更深元素
 *     由 --all 收集时从其它路径覆盖,避免父子重复占满结果)。
 *   - DROP 标签集合由调用方传入(DOM 侧是 SCRIPT/STYLE/NOSCRIPT 等)。
 *
 * 适配器签名:
 *   - getChildren(node):返回子节点数组(可含 light 子 + shadowRoot 子,DOM 侧穿透 shadow)。
 *   - getText(node):返回节点"自身直接文本"(DOM 侧 ownElText,只取直接子文本节点)。
 *   - isElement(node):node 是否为元素(ShadowRoot 自身不参与匹配,但其子递归)。
 *   - tagOf(node):元素的标签名大写(DROP 比对用)。
 */
export interface SearchAdapters<T> {
  getChildren: (node: T) => T[];
  getText: (node: T) => string;
  isElement: (node: T) => boolean;
  tagOf: (node: T) => string;
}

export interface SearchOpts {
  /** 访问节点数上限(防极端爆炸)。默认 200000。 */
  maxVisit?: number;
  /** 跳过这些标签的子树(DROP 标签集,大写)。 */
  dropTags?: Set<string>;
}

/** 默认访问上限:足够覆盖现代 SPA(知乎等深层 DOM 几千到几万元素),同时防百万级爆炸。 */
export const DEFAULT_MAX_VISIT = 200000;

/**
 * DFS(适配器抽象)收集所有"自身直接文本含 needle"的元素。
 * 不设硬深度——只靠 maxVisit + visited Set 控爆炸。命中即止(不深入其子)。
 */
export function searchByText<T>(root: T, needle: string, ad: SearchAdapters<T>, opts: SearchOpts = {}): T[] {
  if (!needle) return [];
  const maxVisit = opts.maxVisit ?? DEFAULT_MAX_VISIT;
  const drop = opts.dropTags ?? new Set<string>();
  const hits: T[] = [];
  const visited = new Set<T>(); // 防环 / 防 shadow 重入
  let visitedCount = 0;
  const walk = (node: T) => {
    if (visitedCount >= maxVisit) return;
    visitedCount++;
    if (visited.has(node)) return;
    visited.add(node);
    // ShadowRoot 自身不参与匹配(无标签);只对其子递归。元素才参与文本匹配。
    if (ad.isElement(node) && !drop.has(ad.tagOf(node)) && ad.getText(node).includes(needle)) {
      hits.push(node);
      return; // 命中即止:不深入其子
    }
    for (const c of ad.getChildren(node)) walk(c);
  };
  walk(root);
  return hits;
}
