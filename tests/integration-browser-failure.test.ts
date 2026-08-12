import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IntegrationHarness } from './integration/harness.ts';

test('浏览器启动失败列出已尝试候选与空 stderr 尾部并清理临时 home', {
  skip: process.platform === 'win32' ? '测试夹具使用 POSIX shell；Windows 由 integration 真机覆盖' : false,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cdp-integration-fail-'));
  const fakeBrowser = join(directory, 'fake-browser');
  writeFileSync(fakeBrowser, '#!/bin/sh\nexit 7\n');
  chmodSync(fakeBrowser, 0o755);

  const harness = new IntegrationHarness([{ exe: fakeBrowser, kind: 'chromium' }]);
  let error: unknown;
  try {
    await harness.start();
  } catch (caught: unknown) {
    error = caught;
  } finally {
    try {
      await harness.cleanup();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  assert.ok(error instanceof Error, '假浏览器必须启动失败');
  assert.match(error.message, /试过的候选:/);
  assert.match(error.message, /候选 chromium .*fake-browser/);
  assert.match(error.message, /exitCode=7 signal=none/);
  assert.match(error.message, /stderr 尾部:\n<empty>/);
  assert.equal(existsSync(harness.home), false, '失败路径也必须删除隔离 CDP_HOME');
});
