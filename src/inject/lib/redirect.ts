/**
 * redirect.ts — 跳转链接自动解码(注入侧,浏览器)。
 *
 * 站点把外链包成跳转 URL(如知乎 `https://link.zhihu.com/?target=<urlencoded>`),article 输出
 * `[文本](href)` 时若原样取 href,得到的是跳转包装而非真实目标。此模块把已知跳转器解回真实 URL。
 *
 * 白名单表格驱动:只解「明文承载真实 URL」的跳转器。百度 `www.baidu.com/link?url=` 的 url 是密文、
 * CSDN link.csdn.net 现为安全校验页、t.co/weixin 需网络或加密强解——一律不碰,原样返回。
 *
 * 不变量:绝不抛异常;未命中/解码失败/目标非白协议 → 原样返回原 href。绝对 http(s) 或 `//` 协议相对
 * 才算干净目标;`javascript:`/`data:` 等一律拒绝。最多两轮 decodeURIComponent,每轮校验,解不出回退。
 */
const REDIRECT_RULES: { host: string; path?: string; param: string }[] = [
  { host: 'link.zhihu.com', param: 'target' },
  { host: 'link.juejin.cn', param: 'target' },
  { host: 'www.google.com', path: '/url', param: 'q' },
  { host: 'l.facebook.com', path: '/l.php', param: 'u' },
  { host: 'lm.facebook.com', path: '/l.php', param: 'u' },
  { host: 'm.facebook.com', path: '/l.php', param: 'u' },
  { host: 'facebook.com', path: '/l.php', param: 'u' },
];

/** 目标是否「干净」:绝对 http(s) 或协议相对 `//`(浏览器可解析);拒绝 javascript:/data: 等。 */
function isCleanTarget(s: string): boolean {
  return /^\/\/[^/\s]/.test(s) || /^https?:\/\/[^/\s]+/.test(s);
}

/** 把跳转包装 URL 解回真实目标;无法可靠解码时原样返回。 */
export function decodeRedirectUrl(href: string): string {
  if (!href) return href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const rule = REDIRECT_RULES.find(r => r.host === url.hostname && (r.path === undefined || r.path === url.pathname));
  if (!rule) return href;
  const raw = url.searchParams.get(rule.param);
  if (!raw) return href;

  // 最多两轮解码,每轮先校验当前值、再尝试再解一层;全不过回退原 href。
  let candidate = raw;
  for (let i = 0; i < 2; i++) {
    if (isCleanTarget(candidate)) return candidate;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      break;
    }
    if (decoded === candidate) break;
    candidate = decoded;
  }
  return isCleanTarget(candidate) ? candidate : href;
}
