/**
 * fill.ts — 向指定 selector 输入框填值(入口)。参数:__CDP_ARG__.sel / .value。
 * 派发 input/change 事件(触发 React/Vue 等受控组件)。
 */
import { setResult } from './lib/result';
import { findTarget, notFoundResult } from './lib/find';
import { actionSelector } from './lib/find-root';
import type { FillArgs } from './lib/arg';

declare const __CDP_ARG__: FillArgs;

(() => {
  const el = findTarget(__CDP_ARG__) as HTMLElement | null;
  if (!el) return setResult(notFoundResult(__CDP_ARG__));
  if (!['INPUT', 'TEXTAREA', 'SELECT', '[contenteditable=true]'].some(x => el.matches(x)))
    return setResult({ ok: false, err: '不是输入元素: ' + el.tagName });
  const proto =
    el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : el.tagName === 'INPUT'
        ? HTMLInputElement.prototype
        : HTMLElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, __CDP_ARG__.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return setResult({ ok: true, tag: el.tagName.toLowerCase(), ...actionSelector(el) });
})();
