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

/**
 * 假端点:`cdp` 决定 /json/version 的应答。
 * - `true` / `false`:恒定按 CDP 应答 / 恒定 404。
 * - `'hang'`:接受连接但**永不应答**——这是"只 accept 不回话"的占用者,只有它才能逼出探测的超时参数。
 * - `{ cdpAfterMs }`:先 404,过了这个时间点改按 CDP 应答——模拟并发进程的浏览器在等待窗口内起来了。
 */
type Mode = boolean | 'hang' | { cdpAfterMs: number };
function fakeEndpoint(port: number, cdp: Mode): Promise<Server> {
  const t0 = Date.now();
  const isCdpNow = () =>
    cdp === true ? true
    : typeof cdp === 'object' ? Date.now() - t0 >= cdp.cdpAfterMs
    : false;
  const s = createServer((req, res) => {
    if (cdp === 'hang') return; // 故意不 end():连接挂着,让探测走到超时
    if (isCdpNow() && req.url === '/json/version') {
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
// closeAllConnections:fetch 默认 keep-alive(挂起的连接更是不会自己断),不主动断连的话 close() 会一直等着不回调
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

test('pickPort: 已确认占用且占用者"只接受连接不应答" → 复验探测必须 1s 超时,不拖满默认 5s', async () => {
  const port = await findFreePort(19620);
  // 用挂起端点(而不是秒回 404 的端点)才能真正锁住 `probeReady(1000)` 的那个 1000:
  // 秒回 404 时,传不传 timeout 都是几毫秒返回,断言分辨不出参数被删。
  const srv = await fakeEndpoint(port, 'hang');
  try {
    const t0 = Date.now();
    const r = await pickPort(port, port);
    const ms = Date.now() - t0;
    assert.ok('port' in r && r.port > port, `期望换到更大的空闲端口,实际 ${JSON.stringify(r)}`);
    assert.ok(ms >= 700, `应当真的发了一次复验探测(而不是免探直接换口),实际 ${ms}ms`);
    assert.ok(ms < 2500, `复验探测须收紧到 1s;拖到默认 5s 说明 probeReady 的 1000 丢了,实际 ${ms}ms`);
  } finally { await close(srv); }
});

test('pickPort: 没确认过的端口被非 CDP 占着且一直不就绪 → 等满一轮再换口', async () => {
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

test('pickPort: 等待窗口内浏览器起来了 → 必须被后续探测发现并复用,不许换口(TOCTOU 要害)', async () => {
  const port = await findFreePort(19640);
  // 这条才是并发冷启动的关键语义:等待期间占用者从"非 CDP"变成"活着的浏览器"。
  // 若 probeReadySoon 退化成"sleep 3s 再换口",它拿到的是 {port} 而非 {reused},本例即红。
  const srv = await fakeEndpoint(port, { cdpAfterMs: 1000 });
  try {
    const t0 = Date.now();
    const r = await pickPort(port, null);
    const ms = Date.now() - t0;
    assert.ok('reused' in r, `期望复用等待窗口内就绪的浏览器,实际 ${JSON.stringify(r)}`);
    assert.match(r.reused, /Chrome/);
    assert.ok(ms < 2500, `应在探到就绪时立刻返回,而不是等满整个窗口,实际 ${ms}ms`);
  } finally { await close(srv); }
});
