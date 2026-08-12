/**
 * view-budget.ts — 与 DOM 解耦的 view 总字符预算决策。
 *
 * 输入必须是已经建完树、分配完 ref 并 markText 的 ViewNode。算法只维护独立的
 * `budgetRef -> 折叠摘要` 映射，再交给 formatView 重渲染；不修改树与 ref。
 */
import { formatView, type ViewNode } from './view-format.ts';
import { cut } from './view-utils.ts';

export interface BudgetRenderResult {
  lines: string[];
  used: number;
  foldedRefs: number[];
  withinBudget: boolean;
}

interface Candidate {
  ref: number;
  node: ViewNode;
  renderedChars: number;
  order: number;
  ancestorRefs: number[];
  summary: string;
}

export interface CandidatePosition {
  ref: number;
  ancestorRefs: readonly number[];
}

interface RenderState {
  lines: string[];
  used: number;
}

const MAX_RENDER_BATCHES = 32;

/**
 * 排名靠前者优先；一旦选中某节点，其祖先和后代都不再入选。
 * 这样每个 foldedRef 都对应最终输出中真实存在的一条占位，不会被后选祖先遮住后仍虚计到账单。
 */
export function selectNonOverlappingCandidates<T extends CandidatePosition>(ranked: readonly T[]): T[] {
  const selected: T[] = [];
  const selectedRefs = new Set<number>();
  const blockedAncestors = new Set<number>();
  for (const candidate of ranked) {
    if (selectedRefs.has(candidate.ref) || blockedAncestors.has(candidate.ref)) continue;
    if (candidate.ancestorRefs.some(ref => selectedRefs.has(ref))) continue;
    selected.push(candidate);
    selectedRefs.add(candidate.ref);
    for (const ref of candidate.ancestorRefs) blockedAncestors.add(ref);
  }
  return selected;
}

/** 把字符数压成折叠摘要用的紧凑数量级。 */
export function formatApproxChars(chars: number): string {
  const n = Math.max(0, Math.round(chars));
  if (n < 1000) return String(n);
  const unit = n < 1_000_000 ? 1000 : 1_000_000;
  const suffix = unit === 1000 ? 'k' : 'm';
  const scaled = n / unit;
  const rounded = scaled >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return String(rounded) + suffix;
}

/** 与 formatView 的推荐一致：字符数就是最终各行用换行拼接后的 JS string.length。 */
export const renderedChars = (lines: readonly string[]): number => lines.join('\n').length;

function firstPreview(n: ViewNode): string {
  if (n.text) return n.text;
  if (n.leafValue) return n.leafValue;
  if (n.imgAlt) return n.imgAlt;
  for (const kid of n.kids) {
    const text = firstPreview(kid);
    if (text) return text;
  }
  return '';
}

function previewText(n: ViewNode, maxLen?: number): string {
  const limit = maxLen == null ? 48 : Math.min(48, Math.max(0, maxLen));
  return cut(firstPreview(n), limit);
}

function foldSummary(n: ViewNode, ref: number, renderedSize: number, maxLen?: number): string {
  const label = n.tag + (n.shadow ? '[shadow]' : '');
  const elements = Math.max(1, n.size);
  const preview = previewText(n, maxLen);
  return `▸ [ref=${ref}] ${label} (${elements} 个元素 · 约 ${formatApproxChars(renderedSize)} 字)`
    + (preview ? ` ~"${preview}"` : '');
}

/**
 * 账单中的「已用」包含树行、树与账单间的换行、账单本身。数字位数会影响账单长度，
 * 因此做一个很小的定点迭代，直到 used 与最终拼接长度一致。
 */
function appendLedger(treeLines: string[], budget: number, folded: number): RenderState {
  let used = 0;
  let ledger = '';
  for (let i = 0; i < 8; i++) {
    ledger = `# 预算 ${budget} 字 · 已用 ${used} · 折叠 ${folded} 处(view <ref> 展开)`;
    const next = renderedChars([...treeLines, ledger]);
    if (next === used) return { lines: [...treeLines, ledger], used };
    used = next;
  }
  ledger = `# 预算 ${budget} 字 · 已用 ${used} · 折叠 ${folded} 处(view <ref> 展开)`;
  const finalUsed = renderedChars([...treeLines, ledger]);
  return { lines: [...treeLines, ledger], used: finalUsed };
}

function render(
  root: ViewNode,
  budget: number,
  maxLen: number | undefined,
  folds: ReadonlyMap<number, string>,
  expandedShadowRefs?: ReadonlySet<number>,
): RenderState {
  return appendLedger(formatView(root, maxLen, folds, expandedShadowRefs), budget, folds.size);
}

/**
 * 收集可折叠节点并按「该子树单独渲染后的字符数」降序排列；同体量保持先序顺序。
 * 根节点永不入选，保证 `view <ref> --budget` 只在根内部继续折叠。
 */
function candidates(root: ViewNode, maxLen?: number): Candidate[] {
  const out: Candidate[] = [];
  let order = 0;

  function visit(n: ViewNode, depth: number, ancestorRefs: number[]): void {
    const ref = n.budgetRef ?? n.ref;
    const nextAncestors = ref != null ? [...ancestorRefs, ref] : ancestorRefs;
    if (depth > 0 && ref != null && n.fold == null && n.budgetFoldable !== false) {
      const size = renderedChars(formatView(n, maxLen));
      const summary = foldSummary(n, ref, size, maxLen);
      // 摘要不比原子树短时不值得折；最终还会用整树实渲染再校验实际是否减少。
      if (summary.length < size) {
        out.push({ ref, node: n, renderedChars: size, order: order++, ancestorRefs, summary });
      }
    }
    // 持久 fold 的孩子在真实 buildView 中已被裁掉；即便测试夹具保留，也不能穿过既有折叠继续决策。
    if (n.fold == null) for (const kid of n.kids) visit(kid, depth + 1, nextAncestors);
  }

  visit(root, 0, []);
  return out.sort((a, b) => b.renderedChars - a.renderedChars || a.order - b.order);
}

/**
 * 按子树渲染体量从大到小试折；小集合逐个，大集合切成有界批次并用完整 formatter 复算真实输出。
 * 只有确实减少字符的批次才接受，避免在大页上为每一处折叠都全树重算而退化为 O(N²)。
 * 这避免依赖 DOM 结构猜体量，也能处理 formatter 的路径压缩、内联和 shadow 占位。
 * 若所有可获益子树都折完后骨架+账单仍超预算，保留骨架并以 withinBudget=false 如实返回。
 */
export function renderBudgetedView(root: ViewNode, budget: number, maxLen?: number): BudgetRenderResult {
  const selected = new Map<number, string>();
  return finishBudget(root, budget, maxLen, selected, () => true);
}

function finishBudget(
  root: ViewNode,
  budget: number,
  maxLen: number | undefined,
  selected: Map<number, string>,
  allowed: (candidate: Candidate) => boolean,
  expandedShadowRefs?: ReadonlySet<number>,
): BudgetRenderResult {
  let current = render(root, budget, maxLen, selected, expandedShadowRefs);

  if (current.used > budget) {
    const ranked = selectNonOverlappingCandidates(candidates(root, maxLen).filter(candidate => allowed(candidate)));
    // 大页若每接收一处折叠都全树重渲染会退化为 O(N²)。把排名序列切成有界批次；
    // 每批仍用完整 formatter 实测，只有整批确实缩短输出才接收。
    const batchSize = Math.max(1, Math.ceil(ranked.length / MAX_RENDER_BATCHES));
    for (let start = 0; start < ranked.length; start += batchSize) {
      const trialFolds = new Map(selected);
      for (const candidate of ranked.slice(start, start + batchSize)) {
        if (selected.has(candidate.ref)) continue;
        if (candidate.ancestorRefs.some(ref => selected.has(ref))) continue;
        trialFolds.set(candidate.ref, candidate.summary);
      }
      if (trialFolds.size === selected.size) continue;
      const trial = render(root, budget, maxLen, trialFolds, expandedShadowRefs);
      if (trial.used >= current.used) continue;
      selected.clear();
      for (const [ref, summary] of trialFolds) selected.set(ref, summary);
      current = trial;
      if (current.used <= budget) break;
    }
  }

  return {
    lines: current.lines,
    used: current.used,
    foldedRefs: [...selected.keys()],
    withinBudget: current.used <= budget,
  };
}

function focusPath(root: ViewNode, focusRef: number): ViewNode[] | null {
  const path: ViewNode[] = [];
  function find(n: ViewNode): boolean {
    path.push(n);
    if ((n.budgetRef ?? n.ref) === focusRef) return true;
    for (const kid of n.kids) if (find(kid)) return true;
    path.pop();
    return false;
  }
  return find(root) ? path : null;
}

function collectSubtree(root: ViewNode): Set<ViewNode> {
  const nodes = new Set<ViewNode>();
  function visit(n: ViewNode): void {
    nodes.add(n);
    for (const kid of n.kids) visit(kid);
  }
  visit(root);
  return nodes;
}

/**
 * focus 模式：先把焦点路径之外的区域在首个可登记节点处全部折成骨架，再把剩余预算
 * 只用于焦点子树内部。焦点节点及其祖先永不参与预算折叠。
 */
export function renderFocusedBudgetedView(
  root: ViewNode,
  budget: number,
  focusRef: number,
  maxLen?: number,
): BudgetRenderResult {
  const path = focusPath(root, focusRef);
  if (!path) throw new Error(`focus ref=${focusRef} 不在当前视图树中`);
  const focus = path[path.length - 1];
  const pathNodes = new Set(path);
  const focusNodes = collectSubtree(focus);
  const expandedShadowRefs = new Set<number>();
  for (const node of path) {
    const ref = node.budgetRef ?? node.ref;
    if (node.shadow && ref != null) expandedShadowRefs.add(ref);
  }
  const selected = new Map<number, string>();

  function foldOutside(n: ViewNode): void {
    if (n === focus || n.fold != null) return;
    if (pathNodes.has(n)) {
      for (const kid of n.kids) foldOutside(kid);
      return;
    }
    const ref = n.budgetRef ?? n.ref;
    if (ref != null && n.budgetFoldable !== false) {
      const size = renderedChars(formatView(n, maxLen));
      selected.set(ref, foldSummary(n, ref, size, maxLen));
      return;
    }
    for (const kid of n.kids) foldOutside(kid);
  }

  foldOutside(root);
  return finishBudget(
    root,
    budget,
    maxLen,
    selected,
    candidate => candidate.node !== focus && focusNodes.has(candidate.node),
    expandedShadowRefs,
  );
}
