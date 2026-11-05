/**
 * eval-find-goal.ts — 用实现里的真实函数(parseElements + locateGoal + jevClient)跑评测,只报告数字。
 * 花真钱、访问真实 API,所以不进 npm test。目标和标注是作者自写的,没有端到端证据。
 *
 *   JEV_API_KEY=... node --experimental-strip-types scripts/eval-find-goal.ts [输出.json]
 *
 * 原型基线:top1 92%、top5 97%、无解 AUC 1.00。明显低于基线就查实现差异,不要调文案凑数字。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseElements, locateGoal, type GoalResult } from '../src/find-goal.ts';
import { jevClient, requireJevKey } from '../src/jev.ts';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'find-goal');
const COST_PER_TOKEN = 0.042 / 1e6;
const BUDGET_USD = 1;
const CONCURRENCY = 4;

export interface EvalGoal { page: string; goal: string; gold: string | null; kind: string }
interface EvalRow { goal: EvalGoal; result: GoalResult; rank: number[]; hit1: boolean; hit5: boolean; ms: number }

export const loadGoals = (): EvalGoal[] => JSON.parse(readFileSync(join(FIXTURES, 'goals.json'), 'utf8'));
export const loadTree = (page: string): string[] => readFileSync(join(FIXTURES, 'trees', `${page}.txt`), 'utf8').split('\n').filter(Boolean);

/** 金标:正则匹配完整树行,命中的元素都算对(一个目标可有多个等价 ref)。 */
export function goldRefs(lines: string[], gold: string): Set<number> {
  const rx = new RegExp(gold);
  const out = new Set<number>();
  for (const line of lines) {
    if (!rx.test(line)) continue;
    const m = /\[ref=(\d+)(, visible)?\]\s*$/.exec(line);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

const pct = (xs: boolean[]) => `${xs.filter(Boolean).length}/${xs.length}=${xs.length ? Math.round(100 * xs.filter(Boolean).length / xs.length) : 0}%`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/** AUC:随机一个有解目标的 exists 高于随机一个无解目标的概率,相等算半个。 */
function auc(pos: number[], neg: number[]): number {
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

async function main(): Promise<void> {
  const call = jevClient({ key: requireJevKey() });
  const goals = loadGoals();
  const rows: EvalRow[] = [];
  let tokens = 0;
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < goals.length) {
      if (tokens * COST_PER_TOKEN > BUDGET_USD) throw new Error(`超过预算 $${BUDGET_USD},停止`);
      const goal = goals[next++];
      const lines = loadTree(goal.page);
      const t0 = Date.now();
      const result = await locateGoal(parseElements(lines), goal.goal, { call, limit: 10 });
      tokens += result.inputTokens;
      const gold = goal.gold ? goldRefs(lines, goal.gold) : new Set<number>();
      const rank = result.candidates.map(c => c.ref);
      rows.push({ goal, result, rank, hit1: rank.slice(0, 1).some(r => gold.has(r)), hit5: rank.slice(0, 5).some(r => gold.has(r)), ms: Date.now() - t0 });
    }
  }));

  const pos = rows.filter(r => r.goal.gold);
  const neg = rows.filter(r => !r.goal.gold);
  const zh = (r: EvalRow) => /[一-鿿]/.test(r.goal.goal);
  const existsPos = pos.map(r => r.result.exists);
  const existsNeg = neg.map(r => r.result.exists);
  console.log(`目标 ${rows.length}(有解 ${pos.length} / 无解 ${neg.length}),作者自写,无端到端证据`);
  console.log(`top1 ${pct(pos.map(r => r.hit1))}  top5 ${pct(pos.map(r => r.hit5))}  (基线 92% / 97%)`);
  console.log(`英文 top1 ${pct(pos.filter(r => !zh(r)).map(r => r.hit1))}  中文 top1 ${pct(pos.filter(zh).map(r => r.hit1))}`);
  console.log(`无解 AUC ${auc(existsPos, existsNeg).toFixed(2)} (基线 1.00)`);
  console.log(`有解: 判有 ${pct(existsPos.map(x => x > 0.7))}  不确定 ${pct(existsPos.map(x => x >= 0.3 && x <= 0.7))}  判无 ${pct(existsPos.map(x => x < 0.3))}`);
  console.log(`无解: 判无 ${pct(existsNeg.map(x => x < 0.3))}  不确定 ${pct(existsNeg.map(x => x >= 0.3 && x <= 0.7))}  判有 ${pct(existsNeg.map(x => x > 0.7))}`);
  console.log(`每目标 token 中位 ${median(rows.map(r => r.result.inputTokens))}  延迟中位 ${median(rows.map(r => r.ms))}ms  共 ${tokens} token ≈ $${(tokens * COST_PER_TOKEN).toFixed(4)}`);
  for (const r of pos.filter(r => !r.hit1)) {
    const top = r.result.candidates[0];
    console.log(`  未中 top1: ${r.goal.page} | ${r.goal.goal} | 选了 [ref=${top.ref}] ${top.line.slice(0, 60)}${r.hit5 ? ' | 在 top5' : ' | 不在 top5'}`);
  }
  const out = process.argv[2];
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
}

if (process.argv[1]?.endsWith('eval-find-goal.ts')) {
  main().catch((e: unknown) => { console.error(`错误: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
