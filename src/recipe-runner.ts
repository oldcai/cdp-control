/**
 * recipe-runner.ts — 站点抽取配方的加载与匹配(Node 侧)。
 *
 * recipe 是 URL 作用域的 Node 模块(CJS),放 **git 权威** `rules/recipes/<site>.js`
 * (作者代码,不做 gitignored 镜像,见 rules-store)。命中时 `view`/`fetch`
 * (CLI action 顶层分发)跑它,得到 `{lines}`(文本+内嵌 [ref=N])。
 *
 * **文件形态(L0 站点聚合)**:一文件 = 一站点,文件名只是聚合标签;文件导出**规则数组**:
 *   `module.exports = [ { name, scope: string|string[], extract }, ... ]`
 *   - `scope` 为数组时 = 同一抽取逻辑服务多个 URL 形态(同布局、多地址);
 *   - 数组元素 = 同站点不同布局(不同 extract)。
 *   匹配在「跨文件 × 跨规则」上做全序,排序键取每条规则与其 URL 最匹配的那个 scope(见 bestScope)。
 *
 * 信任边界:recipe 是作者信任的本地代码(等同 run 脚本),非沙箱。extract 收到 `cdp` 参数(完整 api)。
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { urlMatches } from './url-scope.ts';
import { srcRecipesDir } from './rules-store.ts';

interface RecipeRule {
  name: string;
  scope: string | string[];
  extract: (cdp: any, ctx: { target: any; opts: any }) => Promise<{ lines?: string[] } | null>;
}

interface RuleFile {
  file: string;
  rules: RecipeRule[];
}

// 用动态 import 加载 CJS recipe 文件(ESM 测试与 esbuild CJS bundle 都可用;.js 的 default 即 module.exports)。
async function loadRules(dir: string, f: string): Promise<RecipeRule[] | null> {
  try {
    const mod: any = await import(pathToFileURL(join(dir, f)).href);
    const arr = mod?.default ?? mod;
    if (!Array.isArray(arr)) return null;
    const rules = arr.filter(
      r => r && (typeof r.scope === 'string' || Array.isArray(r.scope)) && typeof r.extract === 'function',
    );
    return rules.length ? rules : null;
  } catch {
    return null;
  }
}

/** 列出 rules/recipes/*.js(recipe 是作者代码,直接读 git 权威),读取每条规则(加载失败/无 rules 数组的跳过)。 */
async function listRuleFiles(): Promise<RuleFile[]> {
  const dir = srcRecipesDir();
  if (!existsSync(dir)) return [];
  const files: RuleFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js') || f === '_lib.js') continue; // _lib 是共享工具,非规则
    const rules = await loadRules(dir, f);
    if (rules) files.push({ file: f, rules });
  }
  return files;
}

/** 通配符个数(越小越具体)。 */
function wild(s: string): number {
  return (s.match(/\*/g) || []).length;
}

/** 一条规则里,与 url 匹配且最具体的那个 scope;无匹配返回 null。scope 数组 → 取最具体匹配项。 */
function bestScope(scope: string | string[], url: string): string | null {
  const forms = Array.isArray(scope) ? scope : [scope];
  let best: string | null = null;
  for (const s of forms) {
    if (!urlMatches(s, url)) continue;
    if (!best || wild(s) < wild(best) || (wild(s) === wild(best) && s.length > best.length)) best = s;
  }
  return best;
}

/** 找命中 url 的最具体规则:规则级排序(其最佳 scope 通配符最少 → 更长 → 声明顺序)。 */
export async function matchRecipe(url: string): Promise<{ rule: RecipeRule; file: string } | null> {
  const hits: { rule: RecipeRule; file: string; scope: string; order: number }[] = [];
  let order = 0;
  for (const f of await listRuleFiles()) {
    for (const rule of f.rules) {
      const scope = bestScope(rule.scope, url);
      if (scope) hits.push({ rule, file: f.file, scope, order: order++ });
      else order++;
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => wild(a.scope) - wild(b.scope) || b.scope.length - a.scope.length || a.order - b.order);
  return { rule: hits[0].rule, file: hits[0].file };
}

/** 跑命中 url 的 recipe,返回 `{lines}`;无命中 / extract 异常 / 返回不含 lines → null(上层安全回落树)。 */
export async function runRecipe(url: string, cdp: any, target: any, opts: any): Promise<{ lines: string[] } | null> {
  const m = await matchRecipe(url);
  if (!m) return null;
  try {
    const out = await m.rule.extract(cdp, { target, opts });
    if (!out || !Array.isArray(out.lines)) return null;
    return { lines: out.lines };
  } catch (e) {
    console.error(`[recipe ${m.file}·${m.rule.name}] 失败,回落树:`, (e as Error)?.message || e);
    return null;
  }
}
