/**
 * rules-store.ts — 规则持久化的统一目录与 seed-once(Node 侧)。
 *
 * 规则统一住 `<CDP_HOME>/rules`(默认 ~/.cdp-control/rules;数据 home):用户本机它是指向
 * 根目录 `rules/` 的符号链接(用户规则=根本规则,运行时读写直接落 git 工作树的 rules),干净环境
 * 是真实目录,seed-once 首跑缺文件时从包内 `rules/` 拷默认。recipe 作者代码直接读 git 权威、
 * 不做镜像(曾 seed 到 `rules/recipes/` 双份必漂移——见 2026-08 实测 _lib.js 漂移 22 字节)。
 *
 * 默认定位:`rulesDir()` 用 cdpHome(不依赖 __dirname,故 src/测试与 dist/编译一致);
 * `pkgRulesDir()` 用 __dirname 定位包内 `rules/`(源码=根目录,安装=包内,publish 随包,seed 源稳定)。
 */
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cdpHome, type CdpEnvironment } from './paths.ts';

/** 实时规则目录(默认 <CDP_HOME>/rules;CDP_RULES_DIR 优先覆盖)。 */
export function rulesDir(environment: CdpEnvironment = process.env): string {
  return environment.CDP_RULES_DIR || join(cdpHome(environment), 'rules');
}

/** 包内默认源(根目录 rules/。源码=仓库根,安装=node_modules/cdp-control/。测试用 CDP_RULES_DEFAULT_DIR 覆盖)。 */
export function pkgRulesDir(): string {
  return process.env.CDP_RULES_DEFAULT_DIR || join(__dirname, '..', 'rules');
}

/** recipe 作者代码目录(直接读 git 权威,不做 gitignored 镜像)。recipe-runner 扫此加载。 */
export function srcRecipesDir(): string {
  return join(pkgRulesDir(), 'recipes');
}

// 运行时可写数据的 live 文件名 → seed 文件名(根 rules/ 下同名)。
const SEEDS: readonly string[] = ['fold.csv', 'ignore-links.csv'];

/** seed-once:确保每个运行时可写规则文件在 rules/ 存在(缺则从根 rules/ 拷默认)。幂等。 */
export function ensureRules(): void {
  mkdirSync(rulesDir(), { recursive: true });
  for (const name of SEEDS) {
    const live = join(rulesDir(), name);
    if (existsSync(live)) continue; // 已存在 → 不覆盖(保留用户编辑)
    const src = join(pkgRulesDir(), name);
    if (existsSync(src)) copyFileSync(src, live);
  }
}

/** 实时 fold 规则文件路径(先 seed)。 */
export function foldsLivePath(): string {
  ensureRules();
  return join(rulesDir(), 'fold.csv');
}

/** 实时 ignore-links 规则文件路径(先 seed)。 */
export function linksLivePath(): string {
  ensureRules();
  return join(rulesDir(), 'ignore-links.csv');
}
