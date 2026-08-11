// port.test.ts — 端口空闲探测单测(真实 bind,不 mock;端口从高位段取,避开 9222 等常用口)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { portFree, findFreePort } from '../src/port.ts';

function listen(port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ port, host, exclusive: true }, () => resolve(s));
  });
}
const close = (s: Server) => new Promise<void>(r => s.close(() => r()));

test('portFree: 被占为 false,释放后为 true', async () => {
  const port = await findFreePort(19222);
  const srv = await listen(port);
  assert.equal(await portFree(port), false);
  await close(srv);
  assert.equal(await portFree(port), true);
});

test('findFreePort: 跳过被占端口取下一个', async () => {
  const port = await findFreePort(19300);
  const srv = await listen(port);
  const next = await findFreePort(port);
  assert.ok(next > port, `期望跳过 ${port},实际 ${next}`);
  await close(srv);
});

test('findFreePort: span 内全被占抛清晰错', async () => {
  const a = await findFreePort(19400);
  const s1 = await listen(a);
  let s2: Server | null = null;
  try { s2 = await listen(a + 1); } catch { /* a+1 已被别的进程占着,同样满足"全被占" */ }
  await assert.rejects(() => findFreePort(a, 2), /全被占用/);
  await close(s1);
  if (s2) await close(s2);
});
