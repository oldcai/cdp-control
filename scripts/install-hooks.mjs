#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(scriptDir, '..');
const hooksPath = '.githooks';

export function validateHookSource(source) {
  if (!source.startsWith('#!/bin/sh\n')) throw new Error('pre-commit 必须以 #!/bin/sh + LF 开头');
  if (source.includes('\r')) throw new Error('pre-commit 必须只使用 LF，禁止 CRLF');
  const typecheck = source.indexOf('npm run typecheck');
  const unitTest = source.indexOf('npm test');
  if (typecheck < 0 || unitTest < 0 || typecheck >= unitTest) {
    throw new Error('pre-commit 必须依次执行 npm run typecheck 与 npm test');
  }
}

function runGit(args, rootDir, environment) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: environment,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} 失败 (exit ${result.status ?? 'null'})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

export function installHooks({ rootDir = defaultRootDir, environment = process.env } = {}) {
  const hook = join(rootDir, hooksPath, 'pre-commit');
  validateHookSource(readFileSync(hook, 'utf8'));
  chmodSync(hook, 0o755);
  runGit(['config', '--local', 'core.hooksPath', hooksPath], rootDir, environment);
  const configured = runGit(['config', '--local', '--get', 'core.hooksPath'], rootDir, environment);
  if (configured !== hooksPath) {
    throw new Error(`core.hooksPath 回读不一致: 期望 ${hooksPath}，实际 ${JSON.stringify(configured)}`);
  }
  console.log(`Git hooks 已安装: 本仓库 core.hooksPath=${hooksPath}`);
  console.log('正常 git commit 将依次运行 typecheck + npm test；紧急时可用 git commit --no-verify 绕过');
  return configured;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    installHooks();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
