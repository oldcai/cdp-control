/**
 * ignore-links.ts — 链接黑名单匹配(注入侧,浏览器)。
 * view(内联合并)与 article(只留文本)共用。模式数组由 Node 侧 ignore-links.ts 读入后传入
 * (view 经 __CDP_ARG__.ignoreLinks,article 经 __CDP_ARG__.ignoreLinks)。
 * 匹配 href 的 hostname+pathname(去协议/去 query);pattern 为空 = 全命中。
 */
export function linkIgnored(patterns: string[] | undefined, href: string): boolean {
  if (!patterns || !patterns.length || !href) return false;
  let target = href;
  try {
    const u = new URL(href);
    target = u.hostname + u.pathname;
  } catch {}
  for (const pat of patterns) {
    if (!pat) return true;
    const esc = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('^' + esc.replace(/\*/g, '.*') + '$').test(target)) return true;
  }
  return false;
}
