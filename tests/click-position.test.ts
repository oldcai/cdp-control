import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centerInViewport, matchesClickTarget } from '../src/inject/lib/click-position.ts';

test('centerInViewport: 返回元素矩形中心的 CSS 视口坐标', () => {
  assert.deepEqual(
    centerInViewport({ x: -20, y: 10, width: 50, height: 20 }, { width: 100, height: 80 }),
    { x: 5, y: 20 },
  );
});

test('centerInViewport: 零尺寸或中心在视口外时返回 null', () => {
  const viewport = { width: 100, height: 80 };
  assert.equal(centerInViewport({ x: 10, y: 10, width: 0, height: 20 }, viewport), null);
  assert.equal(centerInViewport({ x: 10, y: 10, width: 20, height: 0 }, viewport), null);
  assert.equal(centerInViewport({ x: 95, y: 10, width: 10, height: 20 }, viewport), null);
  assert.equal(centerInViewport({ x: 10, y: -30, width: 20, height: 20 }, viewport), null);
});

test('matchesClickTarget: 命中目标自身或目标后代均可点击', () => {
  const contains = (parent: string, child: string) => parent === 'target' && child === 'child';
  assert.equal(matchesClickTarget('target', ['target'], contains), true);
  assert.equal(matchesClickTarget('target', ['child'], contains), true);
});

test('matchesClickTarget: 逐层 shadow 命中链可组合判定包含关系', () => {
  const contains = (parent: string, child: string) => parent === 'target' && child === 'shadow-host';
  assert.equal(matchesClickTarget('target', ['shadow-host', 'shadow-child'], contains), true);
});

test('matchesClickTarget: 命中无关 overlay 时拒绝点击', () => {
  assert.equal(matchesClickTarget('target', ['overlay'], () => false), false);
});
