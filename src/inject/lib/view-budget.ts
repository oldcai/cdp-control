/**
 * view-budget.ts — 与 DOM 解耦的 view 总字符预算决策。
 *
 * 输入必须是已经建完树、分配完 ref 并 markText 的 ViewNode。算法只维护独立的
 * `budgetRef -> 折叠摘要` 映射，再交给 formatView 重渲染；不修改树与 ref。
 */
import {
  formatView,
  formatViewWithSpans,
  type ViewFormatSpan,
  type ViewNode,
} from './view-format.ts';
import { cut } from './view-utils.ts';

export interface BudgetRenderResult {
  lines: string[];
  used: number;
  foldedRefs: number[];
  withinBudget: boolean;
}

interface RenderState {
  lines: string[];
  used: number;
}

interface RenderAnalysis extends RenderState {
  spans: ViewFormatSpan[];
}

interface Candidate {
  ref: number;
  node: ViewNode;
  order: number;
  summary: string;
  saving: number;
  children: Candidate[];
  capacity: number;
}

interface CandidateCollection {
  roots: Candidate[];
  byNode: ReadonlyMap<ViewNode, Candidate>;
}

interface FoldPlan {
  candidates: Candidate[];
  saving: number;
}

type PlanOrder = 'ascending' | 'descending';

/** 把字符数压成折叠摘要用的紧凑数量级。 */
export function formatApproxChars(chars: number): string {
  const n = Math.max(0, Math.round(chars));
  if (n < 1000) return String(n);
  const unit = n >= 999_500 ? 1_000_000 : 1000;
  const suffix = unit === 1000 ? 'k' : 'm';
  const scaled = n / unit;
  const rounded = scaled >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return String(rounded) + suffix;
}

/** 与 formatView 的口径一致：字符数就是最终各行用换行拼接后的 JS string.length。 */
export const renderedChars = (lines: readonly string[]): number => lines.join('\n').length;

function previewReader(): (node: ViewNode) => string {
  const memo = new WeakMap<ViewNode, string>();
  return function firstPreview(node: ViewNode): string {
    const cached = memo.get(node);
    if (cached != null) return cached;
    let result = node.text || node.leafValue || node.imgAlt || '';
    if (!result) {
      for (const kid of node.kids) {
        result = firstPreview(kid);
        if (result) break;
      }
    }
    memo.set(node, result);
    return result;
  };
}

function foldSummary(
  node: ViewNode,
  ref: number,
  renderedSize: number,
  firstPreview: (node: ViewNode) => string,
  maxLen?: number,
): string {
  const label = node.tag + (node.shadow ? '[shadow]' : '');
  const elements = Math.max(1, node.size);
  const limit = maxLen == null ? 48 : Math.min(48, Math.max(0, maxLen));
  const preview = cut(firstPreview(node), limit);
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

function analyze(
  root: ViewNode,
  budget: number,
  maxLen: number | undefined,
  folds: ReadonlyMap<number, string>,
  expandedShadowRefs?: ReadonlySet<number>,
): RenderAnalysis {
  const formatted = formatViewWithSpans(root, maxLen, folds, expandedShadowRefs);
  return { ...appendLedger(formatted.lines, budget, folds.size), spans: formatted.spans };
}

function containsSelectedReader(root: ViewNode, selected: ReadonlyMap<number, string>): (node: ViewNode) => boolean {
  const memo = new WeakMap<ViewNode, boolean>();
  function containsSelected(node: ViewNode): boolean {
    const cached = memo.get(node);
    if (cached != null) return cached;
    const ref = node.budgetRef ?? node.ref;
    const result = (ref != null && selected.has(ref)) || node.kids.some(containsSelected);
    memo.set(node, result);
    return result;
  }
  containsSelected(root);
  return containsSelected;
}

/**
 * formatter 在整页上只跑一次，每个候选的收益直接来自它在这次真实输出中的行区间。
 * 因此 shadow host 按整页短占位计算，单子深链也不会对每一层重复渲染子树。
 */
function buildCandidates(
  root: ViewNode,
  spans: readonly ViewFormatSpan[],
  selected: ReadonlyMap<number, string>,
  allowed: (node: ViewNode) => boolean,
  maxLen?: number,
): CandidateCollection {
  const byNode = new Map<ViewNode, Candidate>();
  const containsSelected = containsSelectedReader(root, selected);
  const firstPreview = previewReader();

  for (const span of spans) {
    const node = span.node;
    const ref = node.budgetRef ?? node.ref;
    if (ref == null || selected.has(ref) || containsSelected(node)) continue;
    if (node.fold != null || node.budgetFoldable === false || !allowed(node)) continue;
    const summary = foldSummary(node, ref, span.renderedChars, firstPreview, maxLen);
    const replacementChars = span.depth * 2 + summary.length;
    const saving = span.renderedChars - replacementChars;
    if (saving <= 0) continue;
    byNode.set(node, {
      ref,
      node,
      order: span.order,
      summary,
      saving,
      children: [],
      capacity: 0,
    });
  }

  const roots: Candidate[] = [];
  function link(node: ViewNode, parent: Candidate | null): void {
    const candidate = byNode.get(node);
    const nextParent = candidate ?? parent;
    if (candidate) {
      if (parent) parent.children.push(candidate);
      else roots.push(candidate);
    }
    for (const kid of node.kids) link(kid, nextParent);
  }
  link(root, null);

  function fillCapacity(candidate: Candidate): number {
    const descendants = candidate.children.reduce((sum, child) => sum + fillCapacity(child), 0);
    candidate.capacity = Math.max(candidate.saving, descendants);
    return candidate.capacity;
  }
  for (const candidate of roots) fillCapacity(candidate);
  return { roots, byNode };
}

const emptyPlan = (): FoldPlan => ({ candidates: [], saving: 0 });

function betterPlan(target: number, left: FoldPlan | null, right: FoldPlan | null): FoldPlan | null {
  if (!left) return right;
  if (!right) return left;
  const leftEnough = left.saving >= target;
  const rightEnough = right.saving >= target;
  if (leftEnough !== rightEnough) return leftEnough ? left : right;
  if (leftEnough && left.saving !== right.saving) return left.saving < right.saving ? left : right;
  if (!leftEnough && left.saving !== right.saving) return left.saving > right.saving ? left : right;
  if (left.candidates.length !== right.candidates.length) {
    return left.candidates.length > right.candidates.length ? left : right;
  }
  const leftOrder = left.candidates[0]?.order ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.candidates[0]?.order ?? Number.MAX_SAFE_INTEGER;
  return leftOrder <= rightOrder ? left : right;
}

function maxPlan(candidate: Candidate, memo: WeakMap<Candidate, FoldPlan>): FoldPlan {
  const cached = memo.get(candidate);
  if (cached) return cached;
  const descendantParts = candidate.children.map(child => maxPlan(child, memo));
  const descendants = {
    candidates: descendantParts.flatMap(plan => plan.candidates),
    saving: descendantParts.reduce((sum, plan) => sum + plan.saving, 0),
  };
  const self = { candidates: [candidate], saving: candidate.saving };
  const result = descendants.saving >= self.saving ? descendants : self;
  memo.set(candidate, result);
  return result;
}

function planCandidate(
  candidate: Candidate,
  target: number,
  order: PlanOrder,
  maxMemo: WeakMap<Candidate, FoldPlan>,
): FoldPlan {
  if (target <= 0) return emptyPlan();
  const descendantsCapacity = candidate.children.reduce((sum, child) => sum + child.capacity, 0);
  // 后代已能达标时必须保留更细的渐进展开点；只有后代容量不足才回退到粗祖先。
  if (descendantsCapacity >= target) return planForest(candidate.children, target, order, maxMemo);
  const self = { candidates: [candidate], saving: candidate.saving };
  const descendantParts = candidate.children.map(child => maxPlan(child, maxMemo));
  const descendants = {
    candidates: descendantParts.flatMap(plan => plan.candidates),
    saving: descendantParts.reduce((sum, plan) => sum + plan.saving, 0),
  };
  return betterPlan(target, self, descendants) ?? emptyPlan();
}

/**
 * 从互不相交的子树中贪心挑折叠：在容量升序/降序两种稳定顺序各跑一次，
 * 每个候选只向下传递当前剩余 target 一次。这避免分支树向同一子树传播
 * target / target-sibling / 更多子集差值所形成的指数级状态。
 */
function planForest(
  candidates: readonly Candidate[],
  target: number,
  order: PlanOrder,
  maxMemo: WeakMap<Candidate, FoldPlan>,
): FoldPlan {
  if (target <= 0 || candidates.length === 0) return emptyPlan();
  const available = [...candidates]
    .filter(candidate => candidate.capacity > 0)
    .sort((left, right) => {
      const capacityOrder = order === 'ascending'
        ? left.capacity - right.capacity
        : right.capacity - left.capacity;
      return capacityOrder || left.order - right.order;
    });
  if (!available.length) return emptyPlan();

  const parts: FoldPlan[] = [];
  let remaining = target;
  for (const candidate of available) {
    if (remaining <= 0) break;
    const part = candidate.capacity < remaining
      ? maxPlan(candidate, maxMemo)
      : planCandidate(candidate, remaining, order, maxMemo);
    if (!part.candidates.length) continue;
    parts.push(part);
    remaining -= part.saving;
  }
  return {
    candidates: parts.flatMap(plan => plan.candidates),
    saving: target - remaining,
  };
}

function asResult(state: RenderState, budget: number, folds: ReadonlyMap<number, string>): BudgetRenderResult {
  return {
    lines: state.lines,
    used: state.used,
    foldedRefs: [...folds.keys()],
    withinBudget: state.used <= budget,
  };
}

/**
 * 用一次带 span 的基线渲染规划折叠，再用少量完整渲染校正 formatter 结构变化与账单开销。
 * 每次尝试都从同一基线重新规划，不会留下祖先遮住后代却仍计数的幽灵折叠。
 */
function finishBudget(
  root: ViewNode,
  budget: number,
  maxLen: number | undefined,
  baselineFolds: ReadonlyMap<number, string>,
  allowed: (node: ViewNode) => boolean,
  expandedShadowRefs?: ReadonlySet<number>,
): BudgetRenderResult {
  const baseline = analyze(root, budget, maxLen, baselineFolds, expandedShadowRefs);
  if (baseline.used <= budget) return asResult(baseline, budget, baselineFolds);

  const collection = buildCandidates(root, baseline.spans, baselineFolds, allowed, maxLen);
  if (!collection.roots.length) return asResult(baseline, budget, baselineFolds);

  let target = baseline.used - budget;
  let bestState: RenderState = baseline;
  let bestFolds = new Map(baselineFolds);
  let previousPlanKey = '';
  const maxPlanMemo = new WeakMap<Candidate, FoldPlan>();

  for (let attempt = 0; attempt < 8; attempt++) {
    const ascending = planForest(collection.roots, target, 'ascending', maxPlanMemo);
    const descending = planForest(collection.roots, target, 'descending', maxPlanMemo);
    const plan = betterPlan(target, ascending, descending) ?? emptyPlan();
    if (!plan.candidates.length) break;
    const planKey = plan.candidates.map(candidate => candidate.ref).sort((a, b) => a - b).join(',');
    if (planKey === previousPlanKey) {
      // 结构输出/账单开销可能让同一估算方案仍差少量字符。
      // 继续抬高目标让规划器跨到下一个更粗的方案，而不是立即放弃。
      target += Math.max(8, bestState.used - budget + 8);
      continue;
    }
    previousPlanKey = planKey;

    const trialFolds = new Map(baselineFolds);
    for (const candidate of plan.candidates) trialFolds.set(candidate.ref, candidate.summary);
    const trial = render(root, budget, maxLen, trialFolds, expandedShadowRefs);
    if (trial.used < bestState.used) {
      bestState = trial;
      bestFolds = trialFolds;
    }
    if (trial.used <= budget) return asResult(trial, budget, trialFolds);

    const shortfall = trial.used - budget;
    const nextTarget = target + Math.max(8, shortfall + 8);
    if (nextTarget <= target) break;
    target = nextTarget;
  }

  return asResult(bestState, budget, bestFolds);
}

/**
 * 总量预算：超量时选择一组不重叠占位，尽量接近预算而不直接折掉最外层应用容器。
 * 若所有可获益子树都折完后骨架+账单仍超预算，保留骨架并以 withinBudget=false 如实返回。
 */
export function renderBudgetedView(root: ViewNode, budget: number, maxLen?: number): BudgetRenderResult {
  return finishBudget(root, budget, maxLen, new Map(), () => true);
}

function focusPath(root: ViewNode, focusRef: number): ViewNode[] | null {
  const path: ViewNode[] = [];
  function find(node: ViewNode): boolean {
    path.push(node);
    if ((node.budgetRef ?? node.ref) === focusRef) return true;
    for (const kid of node.kids) if (find(kid)) return true;
    path.pop();
    return false;
  }
  return find(root) ? path : null;
}

function collectSubtree(root: ViewNode): Set<ViewNode> {
  const nodes = new Set<ViewNode>();
  function visit(node: ViewNode): void {
    nodes.add(node);
    for (const kid of node.kids) visit(kid);
  }
  visit(root);
  return nodes;
}

/**
 * focus 模式：焦点路径外只在「占位确实更短」的首个可登记节点处折成骨架，
 * 再把剩余预算只用于焦点子树内部。焦点节点及其祖先永不参与预算折叠。
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
  // ignore-links 会把相邻文本合并成一行，但该行的 ref 只指向末段真实元素。
  // 若把整个合成节点当成焦点，会把 ref 不覆盖的相邻正文也强制展开，
  // 既违反焦点语义，也可能让输出远超预算。这种句柄必须改用可完整展开的祖先 ref。
  if (focus.budgetFoldable === false) {
    throw new Error(`focus ref=${focusRef} 只代表合并文本的末段元素，不能作为独立焦点`);
  }
  const pathNodes = new Set(path);
  const focusNodes = collectSubtree(focus);
  const expandedShadowRefs = new Set<number>();
  for (const node of path) {
    const ref = node.budgetRef ?? node.ref;
    if (node.shadow && ref != null) expandedShadowRefs.add(ref);
  }

  const empty = new Map<number, string>();
  const baseline = analyze(root, budget, maxLen, empty, expandedShadowRefs);
  const outsideCandidates = buildCandidates(root, baseline.spans, empty, () => true, maxLen).byNode;
  const selected = new Map<number, string>();

  function foldOutside(node: ViewNode): void {
    if (node === focus || node.fold != null) return;
    if (pathNodes.has(node)) {
      for (const kid of node.kids) foldOutside(kid);
      return;
    }
    const candidate = outsideCandidates.get(node);
    if (candidate) {
      selected.set(candidate.ref, candidate.summary);
      return;
    }
    for (const kid of node.kids) foldOutside(kid);
  }

  foldOutside(root);
  if (selected.size) {
    const focused = render(root, budget, maxLen, selected, expandedShadowRefs);
    if (focused.used >= baseline.used) selected.clear();
  }
  return finishBudget(
    root,
    budget,
    maxLen,
    selected,
    node => node !== focus && focusNodes.has(node),
    expandedShadowRefs,
  );
}
