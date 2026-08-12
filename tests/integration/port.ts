/** 集成 harness 专用高位端口分配；不属于产品的固定 CDP 端口决策。 */
import { createServer } from 'node:net';

function probeTestBind(port: number): Promise<string> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    server.once('listening', () => server.close(error => resolve(error ? error.message : 'free')));
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

export async function findFreeTestPort(start: number, span: number): Promise<number> {
  let lastFailure = 'unknown';
  for (let port = start; port < start + span; port++) {
    const state = await probeTestBind(port);
    if (state === 'free') return port;
    lastFailure = state;
  }
  throw new Error(`集成测试高位端口 ${start}-${start + span - 1} 均不可绑定（最后原因 ${lastFailure}）`);
}
