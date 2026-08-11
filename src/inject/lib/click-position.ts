/** click-position.ts — 点击中心坐标与逐层 shadow 命中链的纯逻辑。 */

export interface RectLike { x: number; y: number; width: number; height: number }
export interface ViewportLike { width: number; height: number }
export interface Point { x: number; y: number }

/** 零尺寸或中心落在 CSS 视口外时不可用。 */
export function centerInViewport(rect: RectLike, viewport: ViewportLike): Point | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return null;
  return { x, y };
}

/** 每层 elementFromPoint 命中目标自身或其后代即算可点;hitChain 保留跨 shadow 的宿主层。 */
export function matchesClickTarget<T>(
  target: T,
  hitChain: readonly T[],
  contains: (parent: T, child: T) => boolean,
): boolean {
  return hitChain.some(hit => hit === target || contains(target, hit));
}
