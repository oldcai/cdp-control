/**
 * cli-arg-order.test.ts — 位置参数必须先于 needTarget 校验。
 *
 * 实参从左到右求值,所以 `api.info(await needTarget(...), parseRefArg(n), ...)` 会先去解析浏览器目标。
 * 浏览器没起 / --target 无效时,`parseRefArg` 那条"位置参数是 ref 序号,不是网址"的指路提示
 * 就永远到不了 —— 模型只看到端点错误,不知道自己命令本身写错了;更糟的是一条本来就非法的命令
 * 还会白白冷启动一个浏览器。view 一直是先解析后 needTarget,info/article 曾经不是。
 *
 * 用 CDP_NO_AUTOSTART=1 + 隔离 CDP_HOME + 空闲高位端口构造"目标解析必然失败"的环境,
 * 断言错误是 ref 指路而不是端点未就绪。dist/ 由 CI 的 `npm run build` 保证新鲜(与 CI 步骤顺序一致)。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'dist', 'cdp.js');

async function runCli(args: string[], home: string): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        CDP_HOME: home,
        CDP_NO_AUTOSTART: '1',
        // 端点必然不就绪:高位端口 + 拒绝冷启动,保证 needTarget 一定失败。
        CDP_PORT: '45997',
      },
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    const e = error as { code?: number; stderr?: string };
    return { code: e.code ?? 1, stderr: e.stderr ?? '' };
  }
}

test('info / article 的位置参数在 needTarget 之前校验(错误要指路,别被端点错误盖掉)', async t => {
  if (!existsSync(CLI)) {
    t.skip(`未构建 dist/,跳过:${CLI}`);
    return;
  }
  const tmpRoot = join(REPO_ROOT, 'tmp');
  await mkdir(tmpRoot, { recursive: true });
  const home = mkdtempSync(join(tmpRoot, 'cli-arg-order-'));
  try {
    for (const cmd of ['info', 'article', 'view']) {
      const r = await runCli([cmd, 'https://example.com/x'], home);
      assert.notEqual(r.code, 0, `${cmd} 传网址必须失败`);
      assert.match(
        r.stderr,
        /位置参数是 view 输出的 ref 序号/,
        `${cmd} 应先报"位置参数不是 ref",而不是端点未就绪:\n${r.stderr}`,
      );
      assert.doesNotMatch(r.stderr, /拒绝自动启动浏览器/, `${cmd} 不该走到端点解析:\n${r.stderr}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
