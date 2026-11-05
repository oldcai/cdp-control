/**
 * scroll-load.ts — 滚动触发懒加载(评论区等首屏外的内容)。view 与 goal-tree 共用。三种模式:
 * (1) 默认(无 scrollPages/scrollTo):向下/向上各一屏后回原位,固定距离触发当前位置上下懒加载。
 *     刻意不大范围滚多屏再回顶——那会拉飞视口、让 agent 在已展开长内容页时丢失当前位置(曾踩坑)。
 * (2) scrollTo:先滚到匹配该 selector 的元素(B站评论区容器等),停下让懒加载触发。命中不到优雅降级(跳过)。
 * (3) scrollPages:循环向下滚 N 屏(每屏 innerHeight),边滚边检测 scrollHeight 增长,连续 2 次不增长提前停。
 *     适用于无限流(持续滚+等加载);注意:知乎等站点的"用户主动滚动"反爬即便分步滚也可能触发不了,
 *     这是站点反爬不是工具 bug。scrollTo 与 scrollPages 可并用(先滚到元素,再循环滚 N 屏)。
 */

/** 滚动后默认等待内容渲染的毫秒数。 */
export const SCROLL_WAIT_MS = 1000;

export async function scrollToLoad(opts: { scrollTo?: string; scrollPages?: number } = {}): Promise<void> {
  const pause = 150;
  const vh = innerHeight || document.documentElement.clientHeight || 800;
  const h0 = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const start = Math.min(window.scrollY, Math.max(0, h0() - vh));

  // (2) 先滚到指定 selector 元素(若有)。命中不到跳过、不抛错。
  if (opts.scrollTo) {
    try {
      const el = document.querySelector(opts.scrollTo);
      if (el) {
        (el as Element).scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'start' });
        await new Promise(r => setTimeout(r, pause));
      }
    } catch { /* selector 命中不到/scrollIntoView 异常:优雅降级,正常建视图 */ }
  }

  if (opts.scrollPages && opts.scrollPages > 0) {
    // (3) 循环向下滚 N 屏,边滚边检测 scrollHeight 增长,连续 2 次不增长提前停。上限保护防死循环。
    const max = Math.min(opts.scrollPages, 50);
    let stagnant = 0;
    let lastH = h0();
    for (let i = 0; i < max; i++) {
      window.scrollTo(0, window.scrollY + vh);
      await new Promise(r => setTimeout(r, pause));
      const now = h0();
      if (now > lastH) stagnant = 0; else stagnant++;
      lastH = now;
      if (stagnant >= 2) break; // 连续 2 次不增长:已到底/无新内容
    }
    window.scrollTo(0, start); await new Promise(r => setTimeout(r, pause)); // 回原位
  } else if (!opts.scrollTo) {
    // (1) 默认 ±1 屏回弹(无 scrollTo 时——给了 scrollTo 已滚到位,不再回弹)
    const h = h0();
    const down = Math.min(start + vh, Math.max(0, h - vh));
    window.scrollTo(0, down); await new Promise(r => setTimeout(r, pause));
    window.scrollTo(0, Math.max(0, down - vh)); await new Promise(r => setTimeout(r, pause));
    window.scrollTo(0, start); await new Promise(r => setTimeout(r, pause));
  }
}
