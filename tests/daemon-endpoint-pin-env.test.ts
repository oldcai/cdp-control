/**
 * daemon-endpoint-pin-env.test.ts — daemon 侧「端点只认父进程 pin 后经 env 传下的那一对」的回归。
 *
 * PR #12 把「daemon 逻辑身份必须建立在**已 pin 的端点**上」变成结构约束,分两侧:CLI 侧由
 * tests/daemon-endpoint-pin.test.ts 守着;daemon 侧是 cmdListen 首行的 pinEndpointFromEnvironment()
 * —— 缺 CDP_HOST/CDP_PORT 就拒绝启动。daemon 侧那一半此前零覆盖(issue #13:整个删掉 npm test
 * 仍全绿),即没有任何东西守着 daemon **对外发布什么身份**:它一旦以猜测端点开张,别的 CLI 的
 * current / owned-stale 判定就全建立在错误前提上,正是 PR #12 修的那类误接管。
 *
 * 端点是 transport 的模块级状态,且 pin 不可逆(setPort 之后 endpointPinned 永远为真),所以:
 * 1. 本文件独占一个测试进程(node --test 每文件一个子进程),env 在动态 import **之前**设好;
 * 2. 只有未 pin 时才能观察的负路径,必须排在任何一次成功 pin 之前 —— 用有序 subtest 固定顺序,
 *    并在 cmdListen 用例里显式断言这个前置条件(见该用例注释)。
 */
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// daemon 的启动脚本取 `process.argv[1]`,在测试进程里就是本文件。任何让 spawn 路径可达的改动
// (例如变异验证时改坏门禁)都会把本文件当 daemon 再拉起一次,进而自我复制。这里直接短路兜底:
// 单测文件永远不该以 daemon 身份运行,也不该有能力 fork bomb 开发机。
if (process.argv.includes('__daemon')) process.exit(0);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 模块加载时的 env 就是 transport 的「猜测端点」,它同时是「抛错后端点纹丝不动」的基线。
// 负路径注入的 host/port 一律取与基线不同的哨兵值,否则"未被改动"的断言是空的。
process.env.CDP_HOST = '127.0.0.1';
process.env.CDP_PORT = '9222';

const transport = await import('../src/transport.ts');
const monitor = await import('../src/monitor.ts');
const { daemonChildEnvironment } = await import('../src/monitor-endpoint.ts');
const { daemonIdentity } = await import('../src/monitor-health.ts');

const BASELINE_HOST = transport.CONNECTION_HOST;
const BASELINE_PORT = transport.PORT;
const BASELINE_BASE = transport.BASE;

const SENTINEL_HOST = '10.1.2.3';
const SENTINEL_PORT = '43111';
const MISSING_PIN_ERROR = /daemon 缺少父进程 pin 的 CDP_HOST\/CDP_PORT/;

/** 负路径的要害:抛错之后端点必须完全没被动过,不能留下"改了一半"的半 pin 状态。 */
function assertEndpointUntouched(label?: string): void {
  assert.equal(transport.isEndpointPinned(), false, `${label ?? ''} 抛错后不得留下已 pin 状态`);
  assert.equal(transport.CONNECTION_HOST, BASELINE_HOST, `${label ?? ''} 抛错后不得改 CONNECTION_HOST`);
  assert.equal(transport.PORT, BASELINE_PORT, `${label ?? ''} 抛错后不得改 PORT`);
  assert.equal(transport.BASE, BASELINE_BASE, `${label ?? ''} 抛错后不得改 BASE`);
}

/** 恢复 env:undefined 必须 delete,直接赋值会写成字符串 "undefined"。 */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('pinEndpointFromEnvironment: daemon 端点只认父进程 pin 后经 env 传下的那一对', async t => {
  await t.test('缺任一项(含空串)→ 抛错拒绝启动,且不留半 pin 状态', () => {
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      ['两项都缺', {}],
      ['缺 CDP_PORT', { CDP_HOST: SENTINEL_HOST }],
      ['缺 CDP_HOST', { CDP_PORT: SENTINEL_PORT }],
      ['CDP_HOST 空串', { CDP_HOST: '', CDP_PORT: SENTINEL_PORT }],
      ['CDP_PORT 空串', { CDP_HOST: SENTINEL_HOST, CDP_PORT: '' }],
    ];
    for (const [label, environment] of cases) {
      assert.throws(() => transport.pinEndpointFromEnvironment(environment), MISSING_PIN_ERROR, label);
      assertEndpointUntouched(label);
    }
  });

  await t.test('默认参数取 process.env:daemon 无参调用同样 fail closed', () => {
    const savedHost = process.env.CDP_HOST;
    const savedPort = process.env.CDP_PORT;
    delete process.env.CDP_HOST;
    delete process.env.CDP_PORT;
    try {
      assert.throws(() => transport.pinEndpointFromEnvironment(), MISSING_PIN_ERROR);
      assertEndpointUntouched('默认参数');
    } finally {
      restoreEnv('CDP_HOST', savedHost);
      restoreEnv('CDP_PORT', savedPort);
    }
  });

  await t.test('daemon 入口 cmdListen:缺 pin env 时首行就拒绝,绝不以猜测端点开张', async () => {
    const savedHost = process.env.CDP_HOST;
    const savedPort = process.env.CDP_PORT;
    delete process.env.CDP_HOST;
    delete process.env.CDP_PORT;
    try {
      // 前置条件断言:此刻端点未 pin。若哪天有人把本用例排到某次成功 pin 之后,cmdListen 会越过
      // 身份门禁真的 createServer + 轮询 → 用例挂死而不是变红。这一条把"挂死"变成"快速红"。
      assert.equal(transport.isEndpointPinned(), false, '本用例必须排在任何一次成功 pin 之前');
      // 只走负路径:pinEndpointFromEnvironment 在函数首行抛出,createServer/spawn 一概不可达。
      await assert.rejects(monitor.cmdListen(), MISSING_PIN_ERROR);
      assertEndpointUntouched('cmdListen');
    } finally {
      restoreEnv('CDP_HOST', savedHost);
      restoreEnv('CDP_PORT', savedPort);
    }
  });

  await t.test('正路径:pin 到 env 传下的 host/port,CONNECTION_HOST/PORT/BASE 同步', () => {
    transport.pinEndpointFromEnvironment({ CDP_HOST: SENTINEL_HOST, CDP_PORT: SENTINEL_PORT });

    assert.equal(transport.isEndpointPinned(), true);
    assert.equal(transport.CONNECTION_HOST, SENTINEL_HOST);
    assert.equal(transport.PORT, SENTINEL_PORT);
    assert.equal(transport.BASE, `http://${SENTINEL_HOST}:${SENTINEL_PORT}`);
  });

  await t.test('IPv6:裸地址补括号,已带括号幂等(父进程 identity 传下来的就是 [::1])', () => {
    transport.pinEndpointFromEnvironment({ CDP_HOST: '::1', CDP_PORT: '43112' });
    assert.equal(transport.CONNECTION_HOST, '[::1]');
    assert.equal(transport.BASE, 'http://[::1]:43112');

    transport.pinEndpointFromEnvironment({ CDP_HOST: '[::1]', CDP_PORT: '43113' });
    assert.equal(transport.CONNECTION_HOST, '[::1]', '已括号的 host 再 pin 不得变成 [[::1]]');
    assert.equal(transport.BASE, 'http://[::1]:43113');
  });

  await t.test('往返:父进程 identity → child env → daemon pin 后算出的身份完全一致', () => {
    // daemonIdentity/cdpHome 只做路径字符串运算,不落盘,故这里的 home 只是一个路径值。
    const home = resolve(join(REPO_ROOT, 'tmp', 'daemon-endpoint-pin-env-home'));
    const parentIdentity = daemonIdentity({ CDP_HOME: home }, join('unused', 'home'), '[::1]', 43111);
    const childEnvironment = daemonChildEnvironment(
      { CDP_HOME: home, CDP_HOST: '127.0.0.1', CDP_PORT: '9222' },
      parentIdentity,
      19444,
    );

    const savedHome = process.env.CDP_HOME;
    process.env.CDP_HOME = parentIdentity.home;
    try {
      // 这就是 daemon 侧的实际动作:认领 child env 里那对已 pin 的 host/port,再据此发布身份。
      transport.pinEndpointFromEnvironment(childEnvironment);
      assert.deepEqual(monitor.currentDaemonIdentity(), parentIdentity, 'daemon 发布的身份必须等于父进程算出的身份');
    } finally {
      restoreEnv('CDP_HOME', savedHome);
    }
  });
});
