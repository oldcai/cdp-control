/**
 * daemon-endpoint-pin.test.ts — daemon 逻辑身份必须建立在**已 pin 的端点**上。
 *
 * 复现的缺陷:run 脚本以 `cdp.logs()` 作为第一个 api 调用时,transport 端点还停在 env 猜测
 * (CDP_PORT 或 9222),而 browser.json 的权威端口是 9223。用未 pin 的端口算身份 → 健康 daemon
 * 被判成同 home 异 endpoint 的 owned-stale → 五重接管门禁全部为真 → SIGTERM 杀掉健康 watcher。
 *
 * 端点由 transport 模块级状态承载(加载时读 env),所以本文件独占一个测试进程:
 * `node --test` 每个文件一个子进程,env 必须在**动态 import 之前**设好。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// daemon 的启动脚本取 `process.argv[1]`,在测试进程里就是本文件。任何让 spawn 路径可达的改动
// (例如变异验证时改坏门禁)都会把本文件当 daemon 再拉起一次,进而自我复制。这里直接短路兜底:
// 单测文件永远不该以 daemon 身份运行,也不该有能力 fork bomb 开发机。
if (process.argv.includes('__daemon')) process.exit(0);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = resolve(mkdtempSync(join(REPO_ROOT, 'tmp', 'cdp-endpoint-pin-')));

// browser.json 的权威端口(健康 daemon 服务的就是它);env 默认是另一个值,即"未 pin 的猜测"。
const AUTHORITATIVE_CDP_PORT = '9223';
const UNPINNED_ENV_CDP_PORT = '9222';

process.env.CDP_HOME = HOME;
process.env.CDP_HOST = '127.0.0.1';
process.env.CDP_PORT = UNPINNED_ENV_CDP_PORT;
delete process.env.CDP_NO_AUTOSTART;

const monitor = await import('../src/monitor.ts');
const transport = await import('../src/transport.ts');
const { DAEMON_PROTOCOL_MAJOR, DAEMON_PROTOCOL_MINOR, DAEMON_SERVICE } = await import('../src/monitor-health.ts');

/** 一个健康的 v1 daemon:服务权威端口 9223,phase=ready,发布自己的进程实例。 */
const healthPayload = {
  service: DAEMON_SERVICE,
  protocol: { major: DAEMON_PROTOCOL_MAJOR, minor: DAEMON_PROTOCOL_MINOR },
  identity: { home: HOME, cdpHost: '127.0.0.1', cdpPort: AUTHORITATIVE_CDP_PORT },
  instance: { pid: 4312, birth: 'darwin:1786567616:53026' },
  health: { phase: 'ready', targets: 3 },
};

const requests: string[] = [];
const daemon: Server = createServer((request, response) => {
  requests.push(request.url ?? '');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(healthPayload));
});
const logsPort = await new Promise<number>(ready => {
  daemon.listen(0, '127.0.0.1', () => ready((daemon.address() as AddressInfo).port));
});

test('daemon 身份只在端点 pin 之后计算:未 pin 时 fail closed，绝不接管健康 daemon', async t => {
  t.after(() => {
    daemon.close();
    rmSync(HOME, { force: true, recursive: true });
  });

  await t.test('未 pin:拒绝计算身份，连 health 都不探，更不会走到接管', async () => {
    assert.equal(transport.isEndpointPinned(), false);
    assert.throws(() => monitor.currentDaemonIdentity(), new RegExp(monitor.UNPINNED_ENDPOINT_ERROR));
    await assert.rejects(monitor.ensureDaemon(logsPort), new RegExp(monitor.UNPINNED_ENDPOINT_ERROR));
    assert.deepEqual(requests, [], '未 pin 时不得对 daemon 发出任何 health 请求');
    assert.deepEqual(readdirSync(HOME), [], '未 pin 时不得写 PID file 或拉起替代 daemon');
  });

  await t.test('未 pin:autostart 不阻塞调用者，但留下稳定前缀诊断', async () => {
    const diagnostics: string[] = [];
    // 走真实 ensureDaemon(身份门禁在其中),只把端口定到本用例的假 daemon,不碰派生 LOGS_PORT。
    await monitor.maybeSpawnDaemon({
      ensureDaemonImpl: () => monitor.ensureDaemon(logsPort),
      reportError: message => diagnostics.push(message),
    });
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /^cdp-control monitor autostart failed: /);
    assert.match(diagnostics[0], new RegExp(monitor.UNPINNED_ENDPOINT_ERROR));
    assert.deepEqual(requests, []);
  });

  await t.test('pin 到 browser.json 权威 port 后:同 endpoint 的健康 daemon 判 current，直接复用', async () => {
    // ensureBrowser 读到 browser.json 后做的就是这一步(browser.ts 的 setPort(cfg.port))。
    transport.setPort(AUTHORITATIVE_CDP_PORT);
    assert.equal(transport.isEndpointPinned(), true);
    assert.deepEqual(monitor.currentDaemonIdentity(), healthPayload.identity);

    await monitor.ensureDaemon(logsPort);
    assert.deepEqual(requests, ['/health/v1'], '身份一致的 ready daemon 只探一次即复用:不回退 v0、不退出、不 spawn');
    assert.deepEqual(readdirSync(HOME), []);
  });
});
