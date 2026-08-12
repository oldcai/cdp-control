/**
 * folds.ts — fold 折叠规则的持久化(Node 侧)。
 * 规则是数据非代码,统一住 `~/.cdp-control/rules/fold.csv`(见 rules-store.ts:seed-once、不再随 dist 拷贝走)。
 *
 * 文件格式(csv,tab 分隔,固定 5 列,因 selector 可能含空格——genSel 生成后代选择器):
 *   <id>\t<domain>\t<path>\t<selector>\t<note>
 *   - id:稳定标识(单调递增,删除不重排)
 *   - domain:精确(www.bilibili.com)、*.suffix 子域通配(*.zhihu.com 匹配自身+任意子域)、
 *     suffix.* entity 通配(zhihu.* 匹配所有 TLD 的 zhihu)
 *   - path:glob 通配(* 匹配任意字符含 /,如 /video/*、/question/*),空 = 不限定路径
 *   - selector:命中该元素的 CSS selector,即要折叠的区域
 * 行首 # 为注释。
 */
import { readFileSync, existsSync } from 'node:fs';
import { globToRegExp, hostOf, pathOf } from './url-scope.ts';
import { foldsLivePath } from './rules-store.ts';

// 复导出,供 api.ts 等继续从 './folds' 引用(hostOf/pathOf 同时是 fold 的作用域维度)。
export { hostOf, pathOf };

export interface FoldRule {
  id: number;
  domain: string;
  path: string;
  selector: string;
  note: string;
}

/** 规则文件路径:~/.cdp-control/rules/fold.csv(rules-store seed-once 保证存在)。
 * 测试用 CDP_FOLD_FILE 覆盖到临时文件,避免写进真实 ~/.cdp-control/rules/fold.csv。 */
function foldsPath(): string {
  return process.env.CDP_FOLD_FILE || foldsLivePath();
}

/** 域名匹配:精确、*.suffix(自身+子域)、suffix.*(entity,任意 TLD)。 */
export function domainMatch(domain: string, hostname: string): boolean {
  if (!hostname) return false;
  if (domain.startsWith('*.')) {
    const base = domain.slice(2);
    return hostname === base || hostname.endsWith('.' + base);
  }
  if (domain.endsWith('.*')) {
    // entity: base 为域名段,其后接任意单段 TLD(可带子域)
    const base = domain.slice(0, -2);
    return new RegExp(`(^|\\.)${base}(\\.[^.]+)?$`).test(hostname);
  }
  return hostname === domain;
}

/** 路径匹配:path 为 glob,空 = 不限定(globToRegExp 共享自 url-scope)。 */
export function pathMatch(pattern: string, pathname: string): boolean {
  if (!pattern) return true; // 空 = 不限定路径
  return globToRegExp(pattern).test(pathname);
}

/**
 * 解析规则文本(逐行 tab 分列,固定 5 列 id/domain/path/selector/note)。
 * 第一列必须纯数字 id,否则该行跳过(旧格式遗留,不迁移)。行首 # 注释;空行跳过。
 */
export function parseRules(text: string): FoldRule[] {
  const rules: FoldRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const parts = raw.split('\t');
    if (!/^\d+$/.test(parts[0].trim())) continue; // 旧格式/垃圾行,不迁移
    rules.push({
      id: parseInt(parts[0], 10),
      domain: (parts[1] || '').trim(),
      path: (parts[2] || '').trim(),
      selector: (parts[3] || '').trim(),
      note: (parts[4] || '').trim(),
    });
  }
  return rules;
}

/** 读全部持久规则;文件不存在返回空数组。 */
export function loadFolds(): FoldRule[] {
  const p = foldsPath();
  if (!existsSync(p)) return [];
  try {
    return parseRules(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

/** 筛选匹配某 hostname(+pathname)的规则:domainMatch 外,path 再 glob 命中。 */
export function matchFolds(hostname: string, pathname?: string): FoldRule[] {
  const p = pathname || '';
  return loadFolds().filter(r => {
    if (!domainMatch(r.domain, hostname)) return false;
    // pathname 为空(非法 url/about:blank)时,带 path 的规则不命中(避免误折)。
    if (r.path) return p !== '' && pathMatch(r.path, p);
    return true;
  });
}
