/**
 * cli-arg-order.test.ts — 参数校验必须先于 needTarget(浏览器目标解析)。
 *
 * 实参从左到右求值,所以 `api.info(await needTarget(...), parseRefArg(n), ...)`
 * 会先去解析浏览器目标。目标解析失败时(浏览器没起 / --target 无效),本 PR 新增的
 * "位置参数是 ref 序号,不是网址"/"这是 XPath 不是 CSS" 指路提示就永远到不了 ——
 * 模型只看到端点错误,不知道是自己命令写错了;更糟的是一条本来就非法的命令还会
 * 白白冷启动浏览器,click/fill 等默认反馈模式甚至会先装上 observer。
 *
 * **端点必须"可证伪地不可用",否则这个用例会假绿。**
 * 无 browser.json 时 ensureBrowser() 固定用默认 9222、不读 CDP_PORT,
 * 所以靠 env 设端口是无效的:某台机器默认端点上恰好有健康 CDP 时,
 * 错误的求值顺序会先成功走完 needTarget、再由校验抛出同样的提示,用例照样绿。
 * 这里改为写入权威 browser.json,把它的 port 指向一个**当前空闲的端口**,
 * 配合 CDP_NO_AUTOSTART=1 走"端点未就绪,拒绝自动启动"这条干净路径,保证 needTarget 必然失败;
 * 再用一次 `list` 做前提自检,端点若竟然可用就直接判失败,不允许静默假绿。
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'dist', 'cdp.js');

/**
 * 取一个当前空闲的端口,并**立刻释放**。
 *
 * 早期版本是"占住一个非 CDP listener 不放",那是错的:cdp-control 对配置端口上的
 * 非健康 listener 有明确的回收(kill)语义,而这个 listener 就在测试进程里 ——
 * 等于让被测程序来杀测试自己。实测 Windows CI 上前提自检直接不成立(`list` 退出 0)。
 * 空闲端口 + CDP_NO_AUTOSTART=1 走的是"端点未就绪,拒绝自动启动"这条干净路径,
 * 不触发任何回收逻辑,跨平台语义一致。
 *
 * 万一这个端口在释放后被别的进程抢走,它会变成"busy 但不健康"—— 同样导致目标解析失败,
 * 结论不变;而前提自检会兜住任何"竟然可用"的意外。
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const address = server.address();
      if (address == null || typeof address === 'string') return reject(new Error('未取得端口'));
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * **无条件**重建 dist/cdp.js,再拿它做断言。
 *
 * 这条用例测的是 `src/cdp.ts` / `src/api.ts` 里的求值顺序,但跑的是编译产物,
 * 所以"产物到底对不对应当前源码"必须是**证明**,不能是推断。此前两版都栽在间接信号上:
 *   v1 缺 dist 就 `t.skip`   → 全新工作树整条回归静默消失;
 *   v2 比 mtime 判新鲜       → dist 从缓存/备份恢复、或改动落在同一时间戳粒度内时,
 *                              会复用内容无关的旧 bundle,照样假绿。
 * `npm test` 自身不构建、pre-commit 也只跑 typecheck + npm test,所以这个洞是真的。
 *
 * 现在直接调项目自己的 `build.mjs`(实测约 1.5s,相对这条回归的价值可以接受),
 * 构建失败即用例失败 —— 既不 skip,也不猜。
 */
function buildCli(): void {
  const built = spawnSync(process.execPath, [join(REPO_ROOT, 'build.mjs')], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(built.status, 0, `构建 dist/ 失败(本用例必须测当前源码):\n${built.stdout}\n${built.stderr}`);
  assert.ok(existsSync(CLI), `构建后仍无 ${CLI}`);
}

async function runCli(args: string[], home: string): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        CDP_HOME: home,
        CDP_HOST: '127.0.0.1', // 显式控制,别继承外部 CDP_HOST
        CDP_NO_AUTOSTART: '1', // 端点不就绪时拒绝冷启动 → needTarget 必然失败
      },
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    const e = error as { code?: number; stderr?: string };
    return { code: e.code ?? 1, stderr: e.stderr ?? '' };
  }
}

/** 端点必然不可用的断言:命令必须在解析目标之前就因参数非法而失败。 */
async function assertGuardBeatsTarget(args: string[], home: string, expected: RegExp, label: string): Promise<void> {
  const r = await runCli(args, home);
  assert.notEqual(r.code, 0, `${label} 必须失败`);
  assert.match(r.stderr, expected, `${label} 应先报参数防呆,而不是端点错误:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /未就绪|拒绝自动启动浏览器|端点/, `${label} 不该走到端点解析:\n${r.stderr}`);
}

test('参数防呆必须早于 needTarget:位置 ref 与操作目标都不能被端点错误盖掉', async () => {
  buildCli();
  const tmpRoot = join(REPO_ROOT, 'tmp');
  await mkdir(tmpRoot, { recursive: true });
  const home = mkdtempSync(join(tmpRoot, 'cli-arg-order-'));
  const port = await pickFreePort();
  try {
    // 权威配置:端口指向一个空闲端口。exe 取当前 node(必然存在,配置才算合法)。
    writeFileSync(
      join(home, 'browser.json'),
      JSON.stringify({
        exe: process.execPath,
        kind: 'chromium',
        args: [],
        port,
        userData: join(home, 'user-data'),
      }),
    );

    // 前提自检:端点确实不可用 —— 否则下面全部断言都只是假绿。
    const sanity = await runCli(['list'], home);
    assert.notEqual(sanity.code, 0, `前提不成立:端点 ${port} 竟可用,本用例会假绿\n${sanity.stderr}`);

    // ① 位置参数是 ref 序号的命令
    for (const cmd of ['view', 'info', 'article']) {
      await assertGuardBeatsTarget([cmd, 'https://example.com/x'], home, /位置参数是 view 输出的 ref 序号/, cmd);
    }
    // ② 操作目标是 ref 或 selector 的命令(默认反馈模式还会先装 observer,更该提前拦)
    for (const cmd of ['click', 'focus', 'hover']) {
      await assertGuardBeatsTarget([cmd, 'https://example.com/x'], home, /不是网址/, `${cmd} URL`);
      await assertGuardBeatsTarget([cmd, '//div[@id=x]'], home, /XPath/, `${cmd} XPath`);
    }
    await assertGuardBeatsTarget(['fill', '//div[@id=x]', 'v'], home, /XPath/, 'fill XPath');
    await assertGuardBeatsTarget(['click', 'my-app >>> .btn'], home, /shadow 链/, 'click shadow 链');
    // ③ press-key 的按键拼写校验(parseKeySpec)是同一个反模式,虽非本 PR 引入,一并前移
    await assertGuardBeatsTarget(['press-key', 'Ctrl+NoSuchKey'], home, /键/, 'press-key 拼写');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
