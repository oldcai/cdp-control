/**
 * browser-port.ts — CDP 端点就绪探测 + 启动端口决策(只做网络判断,不碰进程/配置/文件)。
 * 从 browser.ts 拆出来的理由:这段逻辑是并发冷启动竞态的要害(本 PR 已为它改了三轮),必须能单测,
 * 而 browser.ts 经 monitor → inject-loader 依赖 `__dirname` 这类 bundle 期才成立的东西,
 * 测试进程里 import 不动。依赖只有 transport + port,两者都无相对依赖 → tests/ 可直接 import。
 */
import { getJson, setPort, HOST } from './transport.ts';
import { portFreeOn, findFreePort } from './port.ts';

/** ready 探活(一次 GET,顺带拿浏览器名)。`timeoutMs` 可收紧:复验占用者身份时不想为"只接受不应答"的占用者等满 5s。 */
export async function probeReady(timeoutMs?: number): Promise<{ ready: boolean; browser?: string }> {
  try {
    const v = await getJson('/json/version', timeoutMs);
    if (!v?.webSocketDebuggerUrl) return { ready: false };
    return { ready: true, browser: describeBrowser(v.Browser || '') };
  } catch { return { ready: false }; }
}

/** 反复探活到就绪或超时(用于"端口有人但可能是正在启动的浏览器")。 */
export async function probeReadySoon(ms = 3000): Promise<{ ready: boolean; browser?: string }> {
  const t0 = Date.now();
  for (;;) {
    const p = await probeReady();
    if (p.ready || Date.now() - t0 >= ms) return p;
    await new Promise(r => setTimeout(r, 300));
  }
}

export function describeBrowser(s: string): string {
  if (/Edg\//i.test(s)) return `Microsoft Edge (${s})`;
  if (/Chrome\//i.test(s)) return `Google Chrome (${s})`;
  return s || '未知浏览器';
}

/**
 * 定端口:want 空闲就用它;被占则分两种,回 `{port}` 要拉起、回 `{reused}` 表示别人已经起好了直接用。
 * ensureBrowser 探空之后、走到这里之前,另一个并发的 cdp-control 可能刚把浏览器绑上端口(TOCTOU
 * 窗口)。这时换口会踩 Chrome 单例:新进程把参数转交给旧实例后自己退出,我们在新端口上白等两轮超时。
 * 故换口之前**总要先问一句"这端口上现在是不是个已就绪的 CDP 端点"**,就绪即复用。
 *
 * `busyProbed`(已确认被外人占着、且已经等过一轮 3s 的那个端口)只决定**等多久**,不决定探不探:
 * - `busyProbed !== want`:这端口我们没等过 → `probeReadySoon` 等满一轮(coldStart 会重读
 *   browser.json,并发进程可能把端口回写成新的,拿旧端口的结论免探会张冠李戴:正好对着刚就绪的
 *   浏览器换口撞单例,2026-08 m2 稳定复现);
 * - `busyProbed === want`:已经等过一轮,不重复等,但仍做**一次** `probeReady(1000)`——
 *   端口号相同不证明占用者还是刚才那个:原先的非 CDP 占用者可能刚退场、并发进程的浏览器接手了
 *   同一个端口,免探就会把它当外人换口撞单例。收紧到 1s 是因为占用者可能"只接受连接不应答",
 *   默认 5s 会白拖冷启动;而这一探本就只为纠正身份假设,不是等浏览器起来(那是上一分支的活)。
 * 换口的理由照旧:不换的话 Chrome 会静默绑到 [::1],客户端连 127.0.0.1 永远超时。
 * 只定端口不写配置(配置由调用方在真起来之后写)。
 */
export async function pickPort(want: number, busyProbed: number | null): Promise<{ port: number } | { reused: string }> {
  setPort(want);
  if (await portFreeOn(want, HOST)) return { port: want };
  {
    const p = busyProbed === want ? await probeReady(1000) : await probeReadySoon();
    if (p.ready) { console.error(`端口 ${want} 上的浏览器已由并发进程拉起,直接复用`); return { reused: p.browser || '未知浏览器' }; }
  }
  const port = await findFreePort(want + 1, 50, HOST);
  setPort(port);
  console.error(`⚠ 端口 ${want} 被其它进程占用(且不是可用的 CDP 端点),改用 ${port}`);
  return { port };
}
