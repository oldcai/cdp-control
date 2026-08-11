/**
 * port.ts — CDP 端口空闲探测(只依赖 node:net)。
 * 存在理由:浏览器只有绑得上 127.0.0.1:<port> 才能被默认 CDP_HOST 访问。端口被别的进程
 * (常见:用户自己手动开、带 remote-debugging 的另一个浏览器)占着时,Chrome **不报错退出**,
 * 而是静默退到 [::1]:<port>,客户端连 127.0.0.1 永远拿不到 /json/version,表现为"启动超时/
 * 未找到可用浏览器"。故启动前先探空、被占就换端口。
 */
import { createServer } from 'node:net';

/** host:port 能否绑定(能绑=空闲)。 */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen({ port, host, exclusive: true });
  });
}

/** 从 start 起找第一个空闲端口(含 start);span 内全被占则抛清晰错。 */
export async function findFreePort(start: number, span = 50, host = '127.0.0.1'): Promise<number> {
  for (let p = start; p < start + span; p++) if (await portFree(p, host)) return p;
  throw new Error(`端口 ${start}-${start + span - 1} 全被占用,无法启动浏览器`);
}

/**
 * 监听地址串(`127.0.0.1:9222` / `[::1]:9222` / `*:9222` / `0.0.0.0:9222`)是否**就是我们连的那个端点**。
 * 端口号相同不代表同一个端点:同一个端口号在 IPv4 与 IPv6 上是两个独立监听,可以属于两个不相干的进程
 * (本仓库实测过:用户自己的 Chrome 占 `127.0.0.1:9222`,另一个 Chrome 退到 `[::1]:9222`)。
 * kill 只能动"我们这条连接对面的那个进程",故按 host 归属判定,不按端口号一刀切。
 */
export function addrServes(addr: string, host: string, port: number): boolean {
  const i = addr.lastIndexOf(':');
  if (i < 0 || addr.slice(i + 1) !== String(port)) return false;
  const a = addr.slice(0, i).replace(/^\[/, '').replace(/\]$/, '');
  if (a === host) return true;
  if (a === '*') return true;                       // lsof 的通配写法,两族都服务
  return host.includes('.') ? a === '0.0.0.0' : a === '::';   // 各自的通配地址
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
 * 解析 posix `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpn` 输出里监听我们那个端点的 pid(纯函数)。
 * `-F` 是机器可读格式:`p<pid>` 起一个进程段,后面的 `n<地址>` 属于它(`f<fd>` 等其它前缀忽略)。
 * 用它而不是 `-t`,就是为了拿到**地址**做归属判定。
 */
export function parseLsofListeners(out: string, port: number, host = '127.0.0.1'): number[] {
  const pids: number[] = [];
  let cur = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('p')) { cur = Number(line.slice(1).trim()) || 0; continue; }
    if (!line.startsWith('n') || !cur) continue;
    if (addrServes(line.slice(1).trim(), host, port) && !pids.includes(cur)) pids.push(cur);
  }
  return pids;
}
