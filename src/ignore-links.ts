/**
 * ignore-links.ts — 链接黑名单的持久化(Node 侧)。
 * 命中黑名单的链接在 article/view 里**只留文本、去 URL**(如知乎 `zhida.zhihu.com/search?...` 词汇释义内部链接,
 * URL 是超长 search 串、无跳转价值,文本才是正文里的词)。跨会话持久。
 *
 * 文件格式(csv,tab 分隔,3 列,~/.cdp-control/rules/ignore-links.csv,见 rules-store.ts):
 *   <id>\t<pattern>\t<note>
 *   - id:稳定标识(单调递增,删除不重排)
 *   - pattern:链接通配符(glob,`*` 匹配任意字符含 /),匹配 href 的 hostname+pathname(去协议/去 query)
 *     —— 如 `zhida.zhihu.com/search*` 命中 https://zhida.zhihu.com/search?content_id=...&q=词
 *   - note:备注
 * 行首 # 为注释。pattern 为空 = 匹配所有。
 */
import { readFileSync, existsSync } from 'node:fs';
import { globToRegExp } from './url-scope.ts';
import { linksLivePath } from './rules-store.ts';

export interface LinkRule {
  id: number;
  pattern: string;
  note: string;
}

/** 规则文件路径:~/.cdp-control/rules/ignore-links.csv(rules-store seed-once 保证存在)。
 * 测试用 CDP_IGNORE_LINKS_FILE 覆盖到临时文件,避免写进真实 ~/.cdp-control/rules/ignore-links.csv。 */
function linksPath(): string {
  return process.env.CDP_IGNORE_LINKS_FILE || linksLivePath();
}

/** 取链接用于模式匹配的串:hostname + pathname(去协议/去 query/去 fragment)。解析失败返回原串。 */
export function hrefForMatch(href: string): string {
  try {
    const u = new URL(href);
    return u.hostname + u.pathname;
  } catch {
    return href;
  }
}

/** 单条规则是否命中某链接:pattern 为空 = 全命中;否则 glob 匹配 hrefForMatch(href)(globToRegExp 共享自 url-scope)。 */
export function linkRuleMatch(rule: LinkRule, href: string): boolean {
  if (!rule.pattern) return true;
  return globToRegExp(rule.pattern).test(hrefForMatch(href));
}

/**
 * 解析规则文本(逐行 tab 分列,3 列 id/pattern/note)。
 * 第一列必须纯数字 id,否则该行跳过(旧格式/垃圾行,不迁移)。行首 # 注释;空行跳过。
 */
export function parseLinkRules(text: string): LinkRule[] {
  const rules: LinkRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const parts = raw.split('\t');
    if (!/^\d+$/.test(parts[0].trim())) continue;
    rules.push({
      id: parseInt(parts[0], 10),
      pattern: (parts[1] || '').trim(),
      note: (parts[2] || '').trim(),
    });
  }
  return rules;
}

/** 读全部持久黑名单规则;文件不存在返回空数组。 */
export function loadLinkRules(): LinkRule[] {
  const p = linksPath();
  if (!existsSync(p)) return [];
  try {
    return parseLinkRules(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}
