/**
 * api-logs-endpoint.test.ts — `logs` 必须和其它 target 命令一样前置 ensureBrowser。
 *
 * 复现的缺陷:logs 曾绕过 api 层直接挂在 CLI 入口上,于是 run 脚本以 `cdp.logs()` 作为第一个 api
 * 调用时,transport 端点还停在 env 猜测(CDP_PORT / 9222),而 browser.json 的权威端口是另一个值。
 * 这里断言的可观察事实:调用 logs 之后端点已被同步到 browser.json 的权威 port——daemon 身份判定
 * (进而接管决策)据此才成立。端点是 transport 的模块级状态,故本文件独占一个测试进程。
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = resolve(join(REPO_ROOT, 'tmp', `cdp-api-logs-${process.pid}`));

/** 取一个当前空闲的高位端口(随即释放):dead 端口让探活立刻 ECONNREFUSED,不依赖真浏览器。 */
function freePort(): Promise<number> {
  return new Promise(ready => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => ready(port));
    });
  });
}

const AUTHORITATIVE_PORT = await freePort(); // browser.json 里的权威 CDP port
const UNPINNED_ENV_PORT = await freePort(); // env CDP_PORT:未 pin 时会被误用的猜测值
assert.notEqual(AUTHORITATIVE_PORT, UNPINNED_ENV_PORT);

mkdirSync(HOME, { recursive: true });
writeFileSync(
  join(HOME, 'browser.json'),
  JSON.stringify({
    exe: join(HOME, 'no-such-browser'),
    kind: 'chrome',
    args: [],
    port: AUTHORITATIVE_PORT,
    userData: join(HOME, 'user-data'),
  }),
);

process.env.CDP_HOME = HOME;
process.env.CDP_HOST = '127.0.0.1';
process.env.CDP_PORT = String(UNPINNED_ENV_PORT);
process.env.CDP_NO_AUTOSTART = '1'; // 端点不就绪就报错,绝不在单测里拉起真浏览器/daemon

const { coreApi } = await import('../src/api.ts');
const transport = await import('../src/transport.ts');

test('api.logs 先 ensureBrowser 把端点 pin 到 browser.json 的权威 port，再做任何 daemon 判定', async t => {
  t.after(() => rmSync(HOME, { force: true, recursive: true }));

  assert.equal(transport.isEndpointPinned(), false, '前置条件:调用前端点仍是未 pin 的 env 猜测');
  assert.equal(String(transport.PORT), String(UNPINNED_ENV_PORT));

  // 没有浏览器在跑,所以这次调用必然失败;要断言的是它失败在**哪一步**——
  // 前置 ensureBrowser(已 pin 权威 port),而不是拿着未 pin 的端点直接去连 target。
  await assert.rejects(coreApi.logs('any-target'), new RegExp(`CDP_NO_AUTOSTART=1.*:${AUTHORITATIVE_PORT} 未就绪`));

  assert.equal(transport.isEndpointPinned(), true);
  assert.equal(String(transport.PORT), String(AUTHORITATIVE_PORT), 'logs 之后端点必须是 browser.json 的权威 port');
  assert.equal(transport.BASE, `http://127.0.0.1:${AUTHORITATIVE_PORT}`);
});
