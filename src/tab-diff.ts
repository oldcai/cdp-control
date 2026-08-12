/**
 * tab-diff.ts — 两次 /json/list 快照的 tab 差异(纯函数,零依赖)。
 * 与 target-arg 同理抽独立模块:api.ts 顶部 import 一堆运行时模块,直接 import 做单测
 * 会拽出整条依赖链且无扩展名 import 在 --experimental-strip-types 下解析失败。
 * Target 类型从 transport 引入则测试链路依旧会连带 transport,故这里声明本地最小结构。
 */

/** 参与 diff 的最小 tab 结构(transport.Target 的子集:仅 id/url 参与比对)。 */
export interface TabSnap {
  id: string;
  url: string;
}

/** 两次快照的 tab 差异:opened=本次新增、closed=本次消失、navigated=同一 tab 跳转。 */
export interface TabDiff {
  opened: TabSnap[];
  closed: TabSnap[];
  /** 同一 id 存在但 url 变化;仅当非空时才挂(无跳转不输出,noise 最小化)。 */
  navigated?: { id: string; from: string; to: string }[];
}

/**
 * 对比 before/after 快照:opened=id 仅在后、closed=id 仅在前、navigated=id 相同但 url 变化。
 * navigated 只在存在跳转时挂字段;before 里 url 为空的导航(about:blank→真实页)from 用 ''。
 */
export function diffTabs(before: TabSnap[], after: TabSnap[]): TabDiff {
  const beforeIds = new Set(before.map(t => t.id));
  const afterIds = new Set(after.map(t => t.id));
  const beforeById = new Map(before.map(t => [t.id, t] as const));
  const navigated: { id: string; from: string; to: string }[] = [];
  for (const t of after) {
    const prev = beforeById.get(t.id);
    if (prev && prev.url !== t.url) navigated.push({ id: t.id, from: prev.url, to: t.url });
  }
  const tabs: TabDiff = {
    opened: after.filter(t => !beforeIds.has(t.id)),
    closed: before.filter(t => !afterIds.has(t.id)),
  };
  if (navigated.length) tabs.navigated = navigated;
  return tabs;
}
