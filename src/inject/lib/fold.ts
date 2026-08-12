/**
 * fold.ts — 会话级临时折叠集合(注入侧共享)。
 * agent 一次性折叠某 ref 区域(不落盘)时,把 {selector, note} 存进页面全局 __cdpFolds。
 * buildView 折叠时与持久规则(Node 侧传入的 folds)合并按 selector 匹配。
 * 生命周期:与 __cdpRefs 一致,页面刷新(新 document)清空。
 */
export interface FoldEntry {
  selector: string;
  note: string;
}

/** 临时折叠数组(不存在则初始化)。 */
export function tmpFolds(): FoldEntry[] {
  if (!(globalThis as any).__cdpFolds) (globalThis as any).__cdpFolds = [];
  return (globalThis as any).__cdpFolds;
}

/** 加一条临时折叠。note 空时用 selector 兜底。 */
export function addTmpFold(selector: string, note: string): void {
  tmpFolds().push({ selector, note: note || selector });
}

/** 清空临时折叠。 */
export function clearTmpFolds(): void {
  (globalThis as any).__cdpFolds = [];
}

/** 列出临时折叠副本。 */
export function listTmpFolds(): FoldEntry[] {
  return tmpFolds().map(f => ({ ...f }));
}
