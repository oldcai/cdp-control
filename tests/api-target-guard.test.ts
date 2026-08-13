/**
 * api-target-guard.test.ts — 脚本 API 的目标防呆必须早于 runWithFeedback。
 *
 * 复现的缺陷:`normArg(arg)`(带 URL / XPath / Playwright / shadow 链防呆)曾写在
 * `runWithFeedback` 的**动作回调里**。于是 `cdp.click('//div[@id=x]')` 这类非法调用会先
 * 装上 MutationObserver、先跑一次 `list()` 做 tab diff,产生页面副作用之后才拒绝;
 * 而且 observer/list 的连接错误还会把参数诊断盖掉——模型看到的是"连不上",
 * 而不是"你写的是 XPath"。CLI 侧已在 needTarget 之前拦一道,但文档同样推荐脚本 API 直调,
 * 这条路径必须自己站得住。
 *
 * 断言的可观察事实:目标非法时,api 抛的是**参数诊断**,而不是端点/连接错误。
 * 端点指向一个空闲端口且 CDP_NO_AUTOSTART=1,所以一旦防呆没有前置,
 * 必然先撞上"端点未就绪"——两种错误互斥,足以区分。
 * 端点是 transport 的模块级状态且 env 必须早于动态 import,故本文件独占一个测试进程。
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = resolve(join(REPO_ROOT, 'tmp', `cdp-api-guard-${process.pid}`));

/** 取一个当前空闲的高位端口(随即释放):dead 端口让探活立刻失败,不依赖真浏览器。 */
function freePort(): Promise<number> {
  return new Promise(ready => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => ready(port));
    });
  });
}

const PORT = await freePort();

mkdirSync(HOME, { recursive: true });
writeFileSync(
  join(HOME, 'browser.json'),
  JSON.stringify({
    exe: join(HOME, 'no-such-browser'),
    kind: 'chrome',
    args: [],
    port: PORT,
    userData: join(HOME, 'user-data'),
  }),
);

process.env.CDP_HOME = HOME;
process.env.CDP_HOST = '127.0.0.1';
process.env.CDP_NO_AUTOSTART = '1'; // 端点不就绪就报错,绝不在单测里拉起真浏览器/daemon

const api = await import('../src/api.ts');

const FAKE_TARGET = {
  id: 'fake-target',
  title: 'fake',
  url: 'about:blank',
  webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/fake-target`,
};

test('脚本 API:非法操作目标在装 observer / 跑 list 之前就被拒,且报的是参数诊断', async t => {
  t.after(() => rmSync(HOME, { force: true, recursive: true }));

  const cases: Array<[string, string, RegExp]> = [
    ['click', '//div[@id=x]', /XPath/],
    ['click', 'https://example.com/x', /不是网址/],
    ['click', 'my-app >>> .btn', /shadow 链/],
    ['focus', '//div[@id=x]', /XPath/],
    ['hover', 'text=登录', /Playwright/],
  ];
  for (const [method, arg, expected] of cases) {
    const call = (api as unknown as Record<string, (t: unknown, a: unknown) => Promise<unknown>>)[method];
    await assert.rejects(call(FAKE_TARGET, arg), expected, `${method}(${arg}) 应抛参数诊断`);
    // 反面:绝不能是端点/连接错误 —— 那说明防呆仍晚于 runWithFeedback
    await assert.rejects(
      call(FAKE_TARGET, arg),
      (e: unknown) => {
        assert.doesNotMatch(String((e as Error).message), /未就绪|拒绝自动启动|ECONNREFUSED|socket/i);
        return true;
      },
      `${method}(${arg}) 不该先撞上端点错误`,
    );
  }

  // fill 的签名多一个 value
  await assert.rejects(api.fill(FAKE_TARGET, '//div[@id=x]', 'v'), /XPath/, 'fill 应抛参数诊断');
});
