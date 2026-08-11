/**
 * ref-registry.test.ts — WeakRef 登记表、反向索引与复用/追加 helper 的纯逻辑单测。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookupRef, registerRef } from '../src/inject/lib/find-root.ts';
import { refOf } from '../src/inject/lib/probe.ts';

type CdpGlobals = typeof globalThis & {
  __cdpRefs?: unknown[];
  __cdpRefIndex?: WeakMap<Element, number>;
};
type WeakEntry = { elRef: WeakRef<Element>; parentRef: number | null };

const globals = globalThis as CdpGlobals;
const fakeElement = (isConnected = true): Element =>
  ({ nodeType: 1, isConnected } as unknown as Element);

beforeEach(() => {
  delete globals.__cdpRefs;
  delete globals.__cdpRefIndex;
});

test('registerRef: 首次登记追加 WeakRef 槽位并建立反向索引', () => {
  const el = fakeElement();
  assert.equal(registerRef(el, null), 0);
  assert.equal(globals.__cdpRefs?.length, 1);
  const entry = globals.__cdpRefs?.[0] as WeakEntry;
  assert.equal(entry.elRef.deref(), el);
  assert.equal(entry.parentRef, null);
  assert.equal(lookupRef(el), 0);
});

test('registerRef: 同一元素复用旧号并刷新 parentRef，不追加新槽位', () => {
  const el = fakeElement();
  const first = registerRef(el, 3);
  assert.equal(registerRef(el), first);
  assert.equal((globals.__cdpRefs?.[0] as WeakEntry).parentRef, 3);
  const second = registerRef(el, 9);
  assert.equal(second, first);
  assert.equal(globals.__cdpRefs?.length, 1);
  assert.equal((globals.__cdpRefs?.[0] as WeakEntry).parentRef, 9);
});

test('registerRef: 兼容旧表并回收强引用形态，首次见到的新元素只追加', () => {
  const old = fakeElement();
  const fresh = fakeElement();
  globals.__cdpRefs = [{ el: old, parentRef: 1 }];

  assert.equal(registerRef(old, 4), 0);
  assert.equal(registerRef(fresh, 0), 1);
  assert.equal(globals.__cdpRefs.length, 2);
  assert.equal((globals.__cdpRefs[0] as WeakEntry).elRef.deref(), old);
  assert.equal((globals.__cdpRefs[0] as WeakEntry).parentRef, 4);
});

test('registerRef: WeakRef 已释放的旧槽位不回收，新元素只能追加新号', () => {
  const released = { deref: () => undefined } as unknown as WeakRef<Element>;
  globals.__cdpRefs = [{ elRef: released, parentRef: null }];

  const fresh = fakeElement();
  assert.equal(registerRef(fresh, null), 1);
  assert.equal(globals.__cdpRefs.length, 2);
  assert.equal((globals.__cdpRefs[0] as WeakEntry).elRef, released);
  assert.equal((globals.__cdpRefs[1] as WeakEntry).elRef.deref(), fresh);
});

test('lookupRef/refOf: O(1) 只查 WeakMap，未登记元素不按需注册', () => {
  const registered = fakeElement();
  const unseen = fakeElement();
  registerRef(registered, null);
  const before = globals.__cdpRefs?.length;

  assert.equal(lookupRef(registered), 0);
  assert.equal(refOf(registered), 0);
  assert.equal(lookupRef(unseen), null);
  assert.equal(refOf(unseen), null);
  assert.equal(globals.__cdpRefs?.length, before);
});
