/**
 * port.ts — CDP 端口空闲探测(只依赖 node:net)。
 * 存在理由:浏览器只有绑得上 127.0.0.1:<port> 才能被默认 CDP_HOST 访问。端口被别的进程
 * (常见:用户自己手动开、带 remote-debugging 的另一个浏览器)占着时,Chrome **不报错退出**,
 * 而是静默退到 [::1]:<port>,客户端连 127.0.0.1 永远拿不到 /json/version,表现为"启动超时/
 * 未找到可用浏览器"。故启动前先探空、被占就换端口。
 */
import { createServer, connect, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * host:port 能否绑定(能绑=空闲)。**只有 `EADDRINUSE` 才算被占**:绑不上的其它原因
 * (地址不属于本机 EADDRNOTAVAIL、低端口 EACCES 等)说明"我们判断不了",这时不该谎称被占
 * 而去换端口——换了照样起不来,还把真因藏了。
 */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const srv = createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e?.code !== 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen({ port, host, exclusive: true });
  });
}

/**
 * host → 应逐个探测的地址集合(异步,可能查 DNS):数值地址/`localhost` 走 `hostAddrs` 不查;
 * 其它主机名 `dns.lookup all:true` 拿**全部**地址——主机名只 `listen` 一次会漏:Node 对主机名
 * 只绑首个解析结果,端口在另一个地址上被占时照样报"空闲",客户端却可能顺着那个地址连到无关进程
 * (与 `localhost` 特判同一类问题,这里推广到任意主机名)。解析失败原样返回,listen/connect
 * 自己会报错,维持"判断不了"语义。`lk` 可注入,单测不打真 DNS。
 */
export async function resolveHostAddrs(host: string, lk: typeof lookup = lookup): Promise<string[]> {
  const addrs = hostAddrs(host);
  if (addrs.length > 1 || isIP(addrs[0])) return addrs;
  try {
    const r = await lk(addrs[0], { all: true });
    return r.length ? r.map(a => a.address) : addrs;
  } catch { return addrs; }
}

async function allFree(port: number, addrs: string[]): Promise<boolean> {
  for (const a of addrs) if (!(await portFree(port, a))) return false;
  return true;
}

/**
 * 端口对**我们要连的那个 host** 是否可用:host 解析出的每个地址都要能绑
 * (`localhost` = 两个回环都得空)。只探 127.0.0.1 会漏:CDP_HOST=localhost 且只有 `[::1]:port`
 * 被别人占着时,IPv4 探测报"空闲",浏览器绑上 IPv4,客户端却可能顺着 ::1 去问那个无关进程。
 */
export async function portFreeOn(port: number, host = '127.0.0.1'): Promise<boolean> {
  return allFree(port, await resolveHostAddrs(host));
}

/** 本机整个地址族没开时,连它得到的错误码(IPv6 关掉的机器上探 `::1` 就是这些)。 */
const FAMILY_OFF = new Set(['EAFNOSUPPORT', 'EPFNOSUPPORT', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'EINVAL']);

/** 回环地址?(它没有"网络中间环节",连不上只可能是本机这一族没开) */
function isLoopback(a: string): boolean {
  return a === '::1' || a === '::ffff:127.0.0.1' || /^127\./.test(a);
}

/**
 * 探测失败该算"这地址在本机压根不是个端点"(跳过)还是"判断不了"(unknown)。
 * **只对回环放宽**:`localhost` 硬带的 `::1` 在关了 IPv6 的机器上必然报 FAMILY_OFF,那不是
 * "状态未知"而是"这地址不存在",不该把已空闲的端口报成 stillUp。远端地址不可达则**仍算未知**——
 * 那可能只是网络断了、对面 CDP 还活着,kill 绝不能因此谎报成功。
 */
export function addrUnusable(addr: string, code: string): boolean {
  return isLoopback(addr) && FAMILY_OFF.has(code);
}

/**
 * 端点是否还有人应答(connect 探测,与客户端连 CDP 的语义一致):`true`=有人监听;
 * `false`=每个地址都明确拒绝(ECONNREFUSED);`null`=判断不了(解析失败/远端不可达/超时,
 * 或所有地址都在本机不可用——什么都没探明)。kill 的"诚实检查"用它——bind 探测(portFree)
 * 只回答"我们能不能绑",对非本机的 CDP_HOST 一律 EADDRNOTAVAIL,会把活着的远程端点误判成"空闲"。
 */
export async function endpointAlive(port: number, host = '127.0.0.1', timeoutMs = 1000, lk: typeof lookup = lookup): Promise<boolean | null> {
  let unknown = false, refused = false;
  for (const a of await resolveHostAddrs(host, lk)) {
    const r = await connectProbe(port, a, timeoutMs);
    if (r === true) return true;
    if (r === false) { refused = true; continue; }
    if (!addrUnusable(a, r)) unknown = true;   // 本机不可用的回环地址:跳过,不污染结论
  }
  if (unknown) return null;
  return refused ? false : null;               // 一个地址都没探明 → 判断不了,别报"没人"
}

/** 单地址 connect 探测:`true`=连上,`false`=ECONNREFUSED(明确没人),其余返回错误码字符串。 */
function connectProbe(port: number, host: string, timeoutMs: number): Promise<boolean | string> {
  return new Promise(resolve => {
    const s = connect({ port, host });
    const done = (v: boolean | string) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done('ETIMEDOUT'));
    s.once('connect', () => done(true));
    s.once('error', (e: NodeJS.ErrnoException) => done(e?.code === 'ECONNREFUSED' ? false : (e?.code || 'UNKNOWN')));
  });
}

/** 从 start 起找第一个对 host 空闲的端口(含 start);span 内全被占则抛清晰错。host 只解析一次。 */
export async function findFreePort(start: number, span = 50, host = '127.0.0.1'): Promise<number> {
  const addrs = await resolveHostAddrs(host);
  for (let p = start; p < start + span; p++) if (await allFree(p, addrs)) return p;
  throw new Error(`端口 ${start}-${start + span - 1} 全被占用,无法启动浏览器`);
}

/** host → 数值地址集合。零依赖、不做 DNS,只归一化最常见的 `localhost`(它同时是两个回环地址)。 */
function hostAddrs(host: string): string[] {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === 'localhost' ? ['127.0.0.1', '::1'] : [h];
}

/** host 落在哪些地址族(决定"通配监听"算不算服务它);认不出的主机名 → 空集。 */
function hostFamilies(host: string): string[] {
  const fams: string[] = [];
  for (const a of hostAddrs(host)) {
    if (a.includes('.')) fams.push('IPv4');
    else if (a.includes(':')) fams.push('IPv6');
  }
  return fams;
}

/**
 * 监听地址串(`127.0.0.1:9222` / `[::1]:9222` / `0.0.0.0:9222` / lsof 的 `*:9222`)是否**就是我们连的那个端点**。
 * 端口号相同不代表同一个端点:同一个端口号在 IPv4 与 IPv6 上是两个独立监听,可以属于两个不相干的进程
 * (本仓库实测过:用户自己的 Chrome 占 `127.0.0.1:9222`,另一个 Chrome 退到 `[::1]:9222`)。
 * kill 只能动"我们这条连接对面的那个进程",故按 host 归属判定,不按端口号一刀切。
 *
 * `family`(lsof `-F` 的 `t` 字段:`IPv4`/`IPv6`)用来给 **`*` 定族**——lsof 把两族的通配监听都写成 `*:port`,
 * 光看地址串区分不出 `0.0.0.0` 和 `::`。**拿不到族就不认**:对 kill 这种破坏性操作,宁可漏杀(可诚实报"没找到")
 * 也不能误杀无关进程。
 */
export function addrServes(addr: string, host: string, port: number, family?: string): boolean {
  const i = addr.lastIndexOf(':');
  if (i < 0 || addr.slice(i + 1) !== String(port)) return false;
  const a = addr.slice(0, i).replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (hostAddrs(host).includes(a)) return true;
  const fams = hostFamilies(host);
  if (a === '0.0.0.0') return fams.includes('IPv4');
  if (a === '::') return fams.includes('IPv6');
  if (a === '*') return !!family && fams.includes(family);
  return false;
}

/**
 * 解析 win `netstat -ano` 输出里**监听我们那个端点**的 pid(纯函数,可跨平台单测)。
 * 只认 `LISTENING`(别把连上来的客户端——比如本工具的 monitor daemon——当浏览器)
 * + 本地地址经 `addrServes` 归属判定(别误伤同端口号、另一地址族上的无关进程)。
 */
export function parseNetstatListeners(out: string, port: number, host = '127.0.0.1'): number[] {
  const pids: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    // 例:  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       6634
    const c = line.trim().split(/\s+/);
    if (c.length < 5 || !/^TCP$/i.test(c[0]) || c[3] !== 'LISTENING' || !addrServes(c[1], host, port)) continue;
    const pid = Number(c[4]);
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/**
 * 解析 posix `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpnt` 输出里监听我们那个端点的 pid(纯函数)。
 * `-F` 是机器可读格式:`p<pid>` 起一个进程段,其后每个 fd 一组 `f<fd>` / `t<族>` / `n<地址>`。
 * 用它而不是 `-t`,是为了同时拿到**地址**与**地址族**做归属判定(`*:port` 两族同形,只能靠 `t` 区分)。
 */
export function parseLsofListeners(out: string, port: number, host = '127.0.0.1'): number[] {
  const pids: number[] = [];
  let cur = 0, fam = '';
  for (const line of out.split(/\r?\n/)) {
    const k = line[0];
    if (k === 'p') { cur = Number(line.slice(1).trim()) || 0; fam = ''; continue; }
    if (k === 'f') { fam = ''; continue; }               // 新 fd:族信息重新收集,别串到下一条
    if (k === 't') { fam = line.slice(1).trim(); continue; }
    if (k !== 'n' || !cur) continue;
    if (addrServes(line.slice(1).trim(), host, port, fam) && !pids.includes(cur)) pids.push(cur);
  }
  return pids;
}
