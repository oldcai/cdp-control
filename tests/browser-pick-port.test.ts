/**
 * browser-pick-port.test.ts — pickPort 的端口决策单测(真实 listen + 假端点,不 mock 网络)。
 * 关键语义:`busyProbed`(调用方"已确认被外人占着、已等过一轮"的那个端口)免掉的是**再等一轮 3s**,
 * 不是"看一眼现在是谁"——端口号相同不证明占用者相同,原占用者退出后并发进程的浏览器可能已绑上同一端口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { pickPort } from '../src/browser-port.ts';
import { findFreePort } from '../src/port.ts';

/** 假端点:cdp=true 按 CDP 应答 /json/version(= 端口上是活着的浏览器),否则一律 404(= 端口有人但不是 CDP)。 */
function fakeEndpoint(port: number, cdp: boolean): Promise<Server> {
  const s = createServer((req, res) => {
    if (cdp && req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'Chrome/9.9.9', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(s));
  });
}
// closeAllConnections:fetch 默认 keep-alive,不主动断连的话 close() 会一直等着不回调
const close = (s: Server) => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); });

test('pickPort: 端口空闲直接用', async () => {
  const port = await findFreePort(19600);
  assert.deepEqual(await pickPort(port, null), { port });
});

test('pickPort: 已确认占用的端口也要重新看一眼——占用者换成活着的浏览器就复用,不换口', async () => {
  const port = await findFreePort(19610);
  // 场景:原来的非 CDP 监听者在调用方等完那一轮之后退出,并发冷启动的浏览器随即绑上同一个端口。
  // 端口号没变,busyProbed 仍等于它;若据此免探就会对着刚就绪的浏览器换口,撞同 user-data 单例等到超时。
  const srv = await fakeEndpoint(port, true);
  try {
    const r = await pickPort(port, port);
    assert.ok('reused' in r, `期望复用端口上已就绪的浏览器,实际 ${JSON.stringify(r)}`);
    assert.match(r.reused, /Chrome/);
  } finally { await close(srv); }
});

test('pickPort: 已确认占用且占用者仍非 CDP → 快速换口(免掉重复的 3s 等待)', async () => {
  const port = await findFreePort(19620);
  const srv = await fakeEndpoint(port, false);
  try {
    const t0 = Date.now();
    const r = await pickPort(port, port);
    const ms = Date.now() - t0;
    assert.ok('port' in r && r.port > port, `期望换到更大的空闲端口,实际 ${JSON.stringify(r)}`);
    assert.ok(ms < 1500, `busyProbed 命中时应只单发一次探测,不重复等 3s,实际 ${ms}ms`);
  } finally { await close(srv); }
});

test('pickPort: 没确认过的端口被非 CDP 占着 → 先等一轮再换口(TOCTOU 窗口留给并发进程)', async () => {
  const port = await findFreePort(19630);
  const srv = await fakeEndpoint(port, false);
  try {
    const t0 = Date.now();
    const r = await pickPort(port, null);
    const ms = Date.now() - t0;
    assert.ok('port' in r && r.port > port, `期望换到更大的空闲端口,实际 ${JSON.stringify(r)}`);
    assert.ok(ms >= 2500, `未确认过的端口应等满一轮 probeReadySoon 再换口,实际 ${ms}ms`);
  } finally { await close(srv); }
});
