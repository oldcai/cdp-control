/**
 * fold.ts — fold 临时折叠注入入口(会话级;持久规则由 Node 侧 folds.ts 写文件)。
 * 契约:读取 __CDP_ARG__(ref/ancestor/note 临时折叠,list 列出,clear 清空),结果写 setResult。
 * --save(落盘)由 Node 侧处理(调 locate 拿 selector + 写 fold-selectors.csv),不经此入口。
 */
import { setResult } from './lib/result';
import { addTmpFold, clearTmpFolds, listTmpFolds } from './lib/fold';
import { refElement, climbAncestors } from './lib/find-root';
import { genSel } from './lib/genSel';
import { notFoundResult, type OperableArg } from './lib/find';
import type { FoldArgs } from './lib/arg';

declare const __CDP_ARG__: FoldArgs;

(() => {
  if (__CDP_ARG__.clear) {
    clearTmpFolds();
    return setResult({ ok: true, cleared: true });
  }
  if (__CDP_ARG__.list) return setResult({ ok: true, folds: listTmpFolds() });
  const base = refElement(__CDP_ARG__.ref!);
  if (!base) return setResult(notFoundResult({ ref: __CDP_ARG__.ref! } as OperableArg));
  const el = climbAncestors(base, __CDP_ARG__.ancestor || 0);
  if (!el)
    return setResult({ ok: false, err: `ref=${__CDP_ARG__.ref} 向上爬 ${__CDP_ARG__.ancestor || 0} 层后无元素` });
  const selector = genSel(el);
  if (!selector) return setResult({ ok: false, err: '无法为该元素生成 selector(可能为文档根)' });
  const note = __CDP_ARG__.note || selector;
  addTmpFold(selector, note);
  return setResult({ ok: true, tag: el.tagName.toLowerCase(), selector, note });
})();
