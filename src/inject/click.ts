/** click.ts — 默认校验元素中心命中并返回坐标;dom=true 时显式走旧 DOM 合成点击。 */
import { setResult } from './lib/result';
import { findTarget, notFoundResult } from './lib/find';
import { actionSelector } from './lib/find-root';
import { centerInViewport, matchesClickTarget } from './lib/click-position';
import type { FindArgs } from './lib/arg';

declare const __CDP_ARG__: FindArgs;

function hitChainAt(x: number, y: number): Element[] {
  const hits: Element[] = [];
  let root: Document | ShadowRoot = document;
  while (true) {
    const hit: Element | null = root.elementFromPoint(x, y);
    if (!hit || hits.includes(hit)) break;
    hits.push(hit);
    if (!hit.shadowRoot) break;
    root = hit.shadowRoot;
  }
  return hits;
}

function compactElement(el: Element | undefined): string {
  if (!el) return '<未知元素>';
  const classes = Array.from(el.classList).slice(0, 3).map(name => '.' + name.slice(0, 32)).join('');
  return `<${el.tagName.toLowerCase()}${classes}>`;
}

(() => {
  const el = findTarget(__CDP_ARG__) as HTMLElement | null;
  if (!el) return setResult(notFoundResult(__CDP_ARG__));
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  if (__CDP_ARG__.dom) {
    el.click();
    return setResult({ ok: true, tag: el.tagName.toLowerCase(), ...actionSelector(el) });
  }

  const point = centerInViewport(el.getBoundingClientRect(), {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  if (!point) return setResult({ ok: false, err: '元素不可见/无尺寸' });

  const hits = hitChainAt(point.x, point.y);
  if (!matchesClickTarget(el, hits, (parent, child) => parent.contains(child))) {
    return setResult({ ok: false, err: `被 ${compactElement(hits[hits.length - 1])} 遮挡` });
  }

  // 附唯一 selector:后续对该元素操作优先用 selector 而非 ref,避免 ref 重渲染失效。
  // shadow 内元素不回废 selector(querySelector 查不到),标 shadow:true。
  return setResult({
    ok: true,
    x: point.x,
    y: point.y,
    tag: el.tagName.toLowerCase(),
    ...actionSelector(el),
  });
})();
