/**
 * find.test.ts — recoverRef 判定逻辑(classifyRef)单测(Node 内置 node:test,零依赖)。
 * recoverRef 自身依赖 DOM(buildView),其判定分支抽成 classifyRef(纯,在 find-root.ts)可单测:
 *   - 无登记表 → 'none'(无可恢复)
 *   - 越界 / 槽空 → 'never'(打错号,不走跳表自愈)
 *   - 已登记 → 'live'(走跳表,DOM 部分靠浏览器实测)
 * 自愈成功(命中 isConnected=true 触发 buildView)、整链 detached 失败(null)属 DOM 行为,不在此单测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRef } from '../src/inject/lib/find-root.ts';

type RefTestGlobals = typeof globalThis & { __cdpRefs?: unknown[] };
const refGlobals = globalThis as RefTestGlobals;
type Entry = { elRef: WeakRef<{ isConnected: boolean; nodeType: 1 }>; parentRef: number | null };
const fakeEntry = (isConnected: boolean, parentRef: number | null = null): Entry =>
  ({ elRef: new WeakRef({ isConnected, nodeType: 1 as const }), parentRef });

test('classifyRef: 无 __cdpRefs 登记表 → none', () => {
  refGlobals.__cdpRefs = undefined;
  assert.deepEqual(classifyRef(0), { kind: 'none' });
  refGlobals.__cdpRefs = [];
  assert.deepEqual(classifyRef(0), { kind: 'none' }); // 空数组同样视作无登记
});

test('classifyRef: ref 越界 → never(打错号,不走跳表)', () => {
  refGlobals.__cdpRefs = [fakeEntry(true), fakeEntry(true), fakeEntry(true)];
  assert.deepEqual(classifyRef(99999), { kind: 'never', maxRef: 2 });
  assert.deepEqual(classifyRef(-1), { kind: 'never', maxRef: 2 });
  assert.deepEqual(classifyRef(3), { kind: 'never', maxRef: 2 }); // 刚好越界(长度3,索引0..2)
});

test('classifyRef: 槽存在但内容为空(稀疏数组)→ never', () => {
  const refs: unknown[] = [fakeEntry(true), undefined, fakeEntry(true)];
  refGlobals.__cdpRefs = refs;
  assert.deepEqual(classifyRef(1), { kind: 'never', maxRef: 2 });
});

test('classifyRef: 已登记的 ref → live(起始跳表号 = 该 ref)', () => {
  refGlobals.__cdpRefs = [fakeEntry(false, null), fakeEntry(false, 0), fakeEntry(true, 1)];
  assert.deepEqual(classifyRef(0), { kind: 'live', start: 0, maxRef: 2 });
  assert.deepEqual(classifyRef(2), { kind: 'live', start: 2, maxRef: 2 });
  // 注意:el 是否仍 connected(DOM)由 recoverRef 判定,classifyRef 只管槽位是否登记过
  assert.deepEqual(classifyRef(1), { kind: 'live', start: 1, maxRef: 2 });
});

test('classifyRef: WeakRef deref 失败仍是 live，由 recoverRef 沿 parentRef 继续爬', () => {
  const released = { deref: () => undefined } as unknown as WeakRef<{ isConnected: boolean; nodeType: 1 }>;
  refGlobals.__cdpRefs = [fakeEntry(true), { elRef: released, parentRef: 0 }];
  assert.deepEqual(classifyRef(1), { kind: 'live', start: 1, maxRef: 1 });
});

test('classifyRef: 兼容裸 Element[] 形态(过渡期 / 手塞)', () => {
  // 裸 Element 也能判定为 live(没 parentRef,跳表起点即自身)
  refGlobals.__cdpRefs = [{ nodeType: 1 }, { nodeType: 1 }];
  assert.deepEqual(classifyRef(1), { kind: 'live', start: 1, maxRef: 1 });
});
