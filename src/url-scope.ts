/**
 * url-scope.ts — 共享的 URL 作用域匹配工具(Node 侧,纯函数零依赖)。
 *
 * 消重复:globToRegExp 此前在 folds.ts / ignore-links.ts 各有一份逐字相同的实现。此文件为唯一权威实现,
 * fold(folds.ts)、ignore-links(ignore-links.ts)、recipe 作用域分发(recipe-runner.ts)共用。
 *
 * 三者的匹配**维度/语义不同**,但共享此工具函数:
 *   - fold      用 hostOf/pathOf 拆成 hostname+pathname 两个维度,domainMatch(域名规则×path 规则)正交组合;
 *   - ignore-link 用 hostname+pathname **拼接串**单 glob(hrefForMatch 在 ignore-links.ts);
 *   - recipe    urlMatches(pattern, url) 对 hostname+pathname 拼接串做 glob(作用域,如 `www.zhihu.com/question/*`)。
 */
export function globToRegExp(pat: string): RegExp {
  const esc = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + esc.replace(/\*/g, '.*') + '$');
}

/** 从 url 提取 hostname;非法/空白返回 ''(about:blank 等不参与规则匹配)。 */
export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 从 url 提取 pathname(含根 /);非法/about:blank/无 hostname 返回 ''。 */
export function pathOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (!u.hostname) return '';
    return u.pathname || '/';
  } catch {
    return '';
  }
}

/** url 是否命中作用域 pattern(glob,匹配 hostname+pathname 拼接串)。无 hostname 一律不命中。 */
export function urlMatches(pattern: string, url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname) return false;
    return globToRegExp(pattern).test(u.hostname + u.pathname);
  } catch {
    return false;
  }
}
