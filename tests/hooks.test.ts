import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installHooks, validateHookSource } from '../scripts/install-hooks.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(repoRoot, 'tmp');

function run(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv = process.env) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: environment, shell: false });
}

function assertSuccess(result: ReturnType<typeof run>, label: string): void {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function runNpm(args: string[], cwd: string, environment: NodeJS.ProcessEnv) {
  const npmExecPath = environment.npm_execpath;
  assert.ok(npmExecPath, '测试必须由 npm test 启动，以便跨平台使用 npm_execpath');
  return run(process.execPath, [npmExecPath, ...args], cwd, environment);
}

test('tracked pre-commit 使用 POSIX sh + LF，且快速档严格按 typecheck → unit test 排序', () => {
  const hook = readFileSync(join(repoRoot, '.githooks', 'pre-commit'), 'utf8');
  assert.doesNotThrow(() => validateHookSource(hook));
  assert.equal(hook.includes('\r'), false);
  assert.ok(hook.indexOf('npm run typecheck') < hook.indexOf('npm test'));
  assert.match(readFileSync(join(repoRoot, '.gitattributes'), 'utf8'), /^\.githooks\/\* text eol=lf$/m);

  const mode = run('git', ['ls-files', '--stage', '.githooks/pre-commit'], repoRoot);
  assertSuccess(mode, '读取 hook index mode');
  assert.match(mode.stdout, /^100755 /, 'pre-commit 必须以 100755 进入 Git index');
});

test('安装器只写 local core.hooksPath，并拒绝 CRLF hook', () => {
  mkdirSync(fixtureRoot, { recursive: true });
  const fixture = mkdtempSync(join(fixtureRoot, 'hooks-install-'));
  try {
    assertSuccess(run('git', ['init', '--initial-branch=main'], fixture), 'git init');
    mkdirSync(join(fixture, '.githooks'));
    writeFileSync(join(fixture, '.githooks', 'pre-commit'), '#!/bin/sh\nset -eu\nnpm run typecheck\nnpm test\n');
    installHooks({ rootDir: fixture });
    const configured = run('git', ['config', '--local', '--get', 'core.hooksPath'], fixture);
    assertSuccess(configured, '读取 local core.hooksPath');
    assert.equal(configured.stdout.trim(), '.githooks');

    writeFileSync(join(fixture, '.githooks', 'pre-commit'), '#!/bin/sh\r\nnpm test\r\n');
    assert.throws(() => installHooks({ rootDir: fixture }), /LF/);
  } finally {
    rmSync(fixture, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test('干净 clone 一步安装后普通 commit 被 hook 拦截，--no-verify 原生绕过', () => {
  mkdirSync(fixtureRoot, { recursive: true });
  const workspace = mkdtempSync(join(fixtureRoot, 'hooks-clone-'));
  const source = join(workspace, 'source');
  const clone = join(workspace, 'clone');
  const isolatedHome = join(workspace, 'home');
  const fakeBin = join(workspace, 'fake-bin');
  const hookLog = join(workspace, 'hook.log');
  mkdirSync(source);
  mkdirSync(isolatedHome);

  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
  };

  try {
    assertSuccess(run('git', ['init', '--initial-branch=main'], source, environment), 'fixture git init');
    mkdirSync(join(source, '.githooks'));
    mkdirSync(join(source, 'scripts'));
    writeFileSync(join(source, '.githooks', 'pre-commit'), readFileSync(join(repoRoot, '.githooks', 'pre-commit')));
    writeFileSync(join(source, '.gitattributes'), '.githooks/* text eol=lf\n');
    writeFileSync(
      join(source, 'scripts', 'install-hooks.mjs'),
      readFileSync(join(repoRoot, 'scripts', 'install-hooks.mjs')),
    );
    writeFileSync(join(source, 'package.json'), readFileSync(join(repoRoot, 'package.json')));
    writeFileSync(join(source, 'tracked.txt'), 'base\n');
    assertSuccess(run('git', ['add', '.'], source, environment), 'fixture git add');
    assertSuccess(
      run('git', ['update-index', '--chmod=+x', '.githooks/pre-commit'], source, environment),
      'fixture hook +x',
    );
    assertSuccess(
      run(
        'git',
        ['-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.invalid', 'commit', '-m', 'fixture'],
        source,
        environment,
      ),
      'fixture initial commit',
    );

    assertSuccess(
      run('git', ['-c', 'core.autocrlf=true', 'clone', '--no-hardlinks', source, clone], workspace, environment),
      'fixture clean clone',
    );
    const install = runNpm(['run', 'hooks:install', '--silent'], clone, environment);
    assertSuccess(install, 'npm run hooks:install');
    assert.equal(readFileSync(join(clone, '.githooks', 'pre-commit'), 'utf8').includes('\r'), false);

    assertSuccess(run('git', ['config', 'user.name', 'Hook Test'], clone, environment), '配置 user.name');
    assertSuccess(run('git', ['config', 'user.email', 'hook@example.invalid'], clone, environment), '配置 user.email');
    const before = run('git', ['rev-parse', 'HEAD'], clone, environment);
    assertSuccess(before, '读取初始 HEAD');

    mkdirSync(fakeBin);
    const fakeNpm = join(fakeBin, 'npm');
    writeFileSync(
      fakeNpm,
      [
        '#!/usr/bin/env node',
        "const { appendFileSync } = require('node:fs');",
        "const args = process.argv.slice(2).join(' ');",
        'appendFileSync(process.env.HOOK_LOG, `${args}\\n`);',
        "process.exit(args === 'test' ? 17 : 0);",
        '',
      ].join('\n'),
    );
    chmodSync(fakeNpm, 0o755);
    const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    const hookEnvironment = {
      ...environment,
      HOOK_LOG: hookLog,
      [pathKey]: `${fakeBin}${delimiter}${environment[pathKey] ?? ''}`,
    };

    writeFileSync(join(clone, 'tracked.txt'), 'blocked\n');
    assertSuccess(run('git', ['add', 'tracked.txt'], clone, hookEnvironment), 'stage blocked change');
    const blocked = run('git', ['commit', '-m', 'must be blocked'], clone, hookEnvironment);
    assert.notEqual(blocked.status, 0, `普通 commit 应失败\nstdout:\n${blocked.stdout}\nstderr:\n${blocked.stderr}`);
    assert.deepEqual(readFileSync(hookLog, 'utf8').trim().split('\n'), ['run typecheck', 'test']);
    const afterBlocked = run('git', ['rev-parse', 'HEAD'], clone, hookEnvironment);
    assertSuccess(afterBlocked, '读取拦截后的 HEAD');
    assert.equal(afterBlocked.stdout, before.stdout);

    const bypassed = run('git', ['commit', '--no-verify', '-m', 'bypass'], clone, hookEnvironment);
    assertSuccess(bypassed, 'git commit --no-verify');
    assert.deepEqual(readFileSync(hookLog, 'utf8').trim().split('\n'), ['run typecheck', 'test']);
  } finally {
    rmSync(workspace, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
