// port.test.ts — 端口空闲探测单测(真实 bind,不 mock;端口从高位段取,避开 9222 等常用口)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { portFree, findFreePort, addrServes, parseNetstatListeners, parseLsofListeners } from '../src/port.ts';

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

test('parseNetstatListeners: 只取 LISTENING 且本地端口精确匹配(win 路径,跨平台可测)', () => {
  const out = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       6634',
    '  TCP    127.0.0.1:9222         127.0.0.1:52233        ESTABLISHED     7788', // 客户端连接,不算
    '  TCP    127.0.0.1:52233        127.0.0.1:9222         ESTABLISHED     7788', // 远端才是 9222,不算
    '  TCP    0.0.0.0:92220          0.0.0.0:0              LISTENING       9999', // 前缀相同的别的端口
    '  TCP    [::1]:9222             [::]:0                 LISTENING       6634', // 同 pid 去重
    '  UDP    127.0.0.1:9222         *:*                                    4242', // 非 TCP
  ].join('\r\n');
  assert.deepEqual(parseNetstatListeners(out, 9222), [6634]);
});

test('parseNetstatListeners: 同端口号不同地址族的两个进程,只取服务该 host 的那个', () => {
  const out = '  TCP    127.0.0.1:9223  0.0.0.0:0  LISTENING  11\n  TCP    [::1]:9223  [::]:0  LISTENING  22';
  assert.deepEqual(parseNetstatListeners(out, 9223), [11]);          // 默认 host=127.0.0.1,只认 IPv4 那个
  assert.deepEqual(parseNetstatListeners(out, 9223, '::1'), [22]);   // host 换成 IPv6 才认 [::1]
});

test('addrServes: lsof 的 `*` 通配必须靠 t 字段(IPv4/IPv6)定族,拿不到就不认', () => {
  assert.equal(addrServes('*:9222', '127.0.0.1', 9222, 'IPv4'), true);
  assert.equal(addrServes('*:9222', '127.0.0.1', 9222, 'IPv6'), false);  // v6-only 通配不服务 127.0.0.1
  assert.equal(addrServes('*:9222', '127.0.0.1', 9222), false);          // 没有族信息 → 宁可漏杀不误杀
  assert.equal(addrServes('*:9222', '::1', 9222, 'IPv6'), true);
  assert.equal(addrServes('*:9222', '::1', 9222, 'IPv4'), false);
});

test('addrServes: localhost 归一化成两个回环地址(否则 kill 找不到进程还谎报成功)', () => {
  assert.equal(addrServes('127.0.0.1:9222', 'localhost', 9222), true);
  assert.equal(addrServes('[::1]:9222', 'localhost', 9222), true);
  assert.equal(addrServes('0.0.0.0:9222', 'localhost', 9222), true);
  assert.equal(addrServes('*:9222', 'localhost', 9222, 'IPv6'), true);
  assert.equal(addrServes('10.0.0.5:9222', 'localhost', 9222), false);
});

test('addrServes: 认不出的主机名不匹配任何通配(宁可漏杀)', () => {
  assert.equal(addrServes('0.0.0.0:9222', 'some-host', 9222), false);
  assert.equal(addrServes('*:9222', 'some-host', 9222, 'IPv4'), false);
  assert.equal(addrServes('some-host:9222', 'some-host', 9222), true);   // 原样相等仍认
});

test('addrServes: 只认服务该 host 的监听地址(端口号相同但另一地址族不算)', () => {
  assert.equal(addrServes('127.0.0.1:9222', '127.0.0.1', 9222), true);
  assert.equal(addrServes('0.0.0.0:9222', '127.0.0.1', 9222), true);   // IPv4 通配
  assert.equal(addrServes('*:9222', '127.0.0.1', 9222, 'IPv4'), true); // lsof 通配写法,须带族
  assert.equal(addrServes('[::1]:9222', '127.0.0.1', 9222), false);    // 同端口号但另一族 → 不是我们的端点
  assert.equal(addrServes('[::]:9222', '127.0.0.1', 9222), false);
  assert.equal(addrServes('127.0.0.1:92220', '127.0.0.1', 9222), false);
  // host 换成 IPv6 时反过来
  assert.equal(addrServes('[::1]:9222', '::1', 9222), true);
  assert.equal(addrServes('[::]:9222', '::1', 9222), true);
  assert.equal(addrServes('127.0.0.1:9222', '::1', 9222), false);
});

test('parseLsofListeners: 按 p/t/n 分段取 pid,只留服务该 host 的监听', () => {
  const out = ['p6634', 'f79', 'tIPv4', 'n127.0.0.1:9222',   // 我们的浏览器
               'p99084', 'f49', 'tIPv6', 'n[::1]:9222',      // 同端口号、另一族的无关进程 → 不能杀
               'p12345', 'f7', 'tIPv4', 'n*:9222',           // IPv4 通配 → 服务 127.0.0.1
               'p777', 'f9', 'tIPv4', 'n127.0.0.1:9999'].join('\n');
  assert.deepEqual(parseLsofListeners(out, 9222), [6634, 12345]);
  assert.deepEqual(parseLsofListeners(out, 9222, '::1'), [99084]);
  assert.deepEqual(parseLsofListeners('', 9222), []);
});

test('parseLsofListeners: 同一端口上两族通配同形 `*:port`,只取族对得上的那个(真实 lsof 输出)', () => {
  // 实测 lsof 对 0.0.0.0 与 :: 都打印 `*:port`,只有 t 字段能区分
  const out = ['p111', 'f14', 'tIPv4', 'n*:9223',
               'p222', 'f15', 'tIPv6', 'n*:9223'].join('\n');
  assert.deepEqual(parseLsofListeners(out, 9223), [111]);           // host=127.0.0.1
  assert.deepEqual(parseLsofListeners(out, 9223, '::1'), [222]);
  assert.deepEqual(parseLsofListeners(out, 9223, 'localhost'), [111, 222]);
});

test('parseLsofListeners: 同一进程多个 fd,族信息不串味', () => {
  const out = ['p500', 'f7', 'tIPv6', 'n*:9224', 'f8', 'tIPv4', 'n127.0.0.1:9224'].join('\n');
  assert.deepEqual(parseLsofListeners(out, 9224), [500]);           // 第二个 fd 才是 IPv4
  const only6 = ['p501', 'f7', 'tIPv6', 'n*:9225', 'f8', 'n*:9225'].join('\n');
  assert.deepEqual(parseLsofListeners(only6, 9225), []);            // 第二个 fd 无 t → 不认
});
