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
