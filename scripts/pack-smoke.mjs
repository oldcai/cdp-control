#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

// package.json 的 files 只声明 dist/rules/skills；npm 还会自动纳入 package.json、README 与 LICENSE。
export const EXPECTED_PACKAGE_ROOTS = Object.freeze([
  'LICENSE',
  'README.md',
  'dist',
  'package.json',
  'rules',
  'skills',
]);

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function packageRoots(files) {
  return sortedUnique(files.map(file => String(file.path).replaceAll('\\', '/').split('/')[0]).filter(Boolean));
}

export function assertExactPackageRoots(actual, expected = EXPECTED_PACKAGE_ROOTS) {
  const actualRoots = sortedUnique(actual);
  const expectedRoots = sortedUnique(expected);
  const actualSet = new Set(actualRoots);
  const expectedSet = new Set(expectedRoots);
  const unexpected = actualRoots.filter(root => !expectedSet.has(root));
  const missing = expectedRoots.filter(root => !actualSet.has(root));
  if (unexpected.length === 0 && missing.length === 0) return;

  throw new Error(
    [
      'pack 顶层白名单漂移:',
      `  多余: ${unexpected.length ? unexpected.join(', ') : '(无)'}`,
      `  缺失: ${missing.length ? missing.join(', ') : '(无)'}`,
      `  期望: ${expectedRoots.join(', ')}`,
      `  实际: ${actualRoots.join(', ')}`,
    ].join('\n'),
  );
}

export function parseNpmJsonArray(stdout) {
  const candidates = [0];
  for (const match of stdout.matchAll(/(?:^|\r?\n)(\[)/g)) {
    const index = (match.index ?? 0) + match[0].lastIndexOf('[');
    if (index !== 0) candidates.push(index);
  }
  for (const index of candidates.reverse()) {
    try {
      const parsed = JSON.parse(stdout.slice(index).trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  throw new Error(`找不到有效的 JSON 数组:\n${stdout}`);
}

function npmCliPath() {
  if (!process.env.npm_execpath) {
    throw new Error('缺少 npm_execpath；请通过 `npm run test:pack` 执行，以保证 Windows 也使用正确的 npm CLI');
  }
  return process.env.npm_execpath;
}

function runNpm(args, options) {
  const result = spawnSync(process.execPath, [npmCliPath(), ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [`npm ${args.join(' ')} 失败(exit ${result.status ?? 'null'})`, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return { stderr: result.stderr, stdout: result.stdout };
}

function packMetadata(stdout) {
  const parsed = parseNpmJsonArray(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('npm pack 必须恰好返回一个包');
  const metadata = parsed[0];
  if (!metadata || typeof metadata.filename !== 'string' || !Array.isArray(metadata.files)) {
    throw new Error('npm pack 元数据缺少 filename/files');
  }
  return metadata;
}

function assertIncludes(output, expected, command) {
  if (!output.includes(expected)) {
    throw new Error(`${command} 未输出关键文本 ${JSON.stringify(expected)}:\n${output}`);
  }
}

function main() {
  const tmpRoot = join(repoRoot, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const workspace = mkdtempSync(join(tmpRoot, 'pack-smoke-'));
  const packedDir = join(workspace, 'packed');
  const consumerDir = join(workspace, 'consumer');
  const isolatedCdpHome = join(workspace, 'cdp-home');
  let summary;

  try {
    mkdirSync(packedDir);
    mkdirSync(consumerDir);
    mkdirSync(isolatedCdpHome);

    const packed = runNpm(['pack', '--loglevel=error', '--json', '--pack-destination', packedDir], { cwd: repoRoot });
    const metadata = packMetadata(packed.stdout);
    const roots = packageRoots(metadata.files);
    assertExactPackageRoots(roots);

    const tarball = join(packedDir, metadata.filename);
    if (!existsSync(tarball)) throw new Error(`npm pack 声明的 tarball 不存在: ${tarball}`);

    writeFileSync(
      join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'cdp-control-pack-smoke-consumer',
          version: '0.0.0',
          private: true,
          scripts: {
            'smoke:help': 'cdp-control --help',
            'smoke:kill': 'cdp-control kill',
          },
        },
        null,
        2,
      )}\n`,
    );
    runNpm(['install', '--silent', '--no-audit', '--no-fund', '--no-package-lock', tarball], {
      cwd: consumerDir,
    });

    const installedRoot = join(consumerDir, 'node_modules', 'cdp-control');
    assertExactPackageRoots(readdirSync(installedRoot));

    const smokeEnvironment = {
      ...process.env,
      CDP_FOLD_FILE: join(isolatedCdpHome, 'rules', 'fold.csv'),
      CDP_HOME: isolatedCdpHome,
      CDP_HOST: '127.0.0.1',
      CDP_IGNORE_LINKS_FILE: join(isolatedCdpHome, 'rules', 'ignore-links.csv'),
      CDP_LOGS_PORT: String(50000 + (process.pid % 10000)),
      CDP_NO_AUTOSTART: '1',
      CDP_PORT: String(40000 + (process.pid % 10000)),
      CDP_RULES_DEFAULT_DIR: join(installedRoot, 'rules'),
      CDP_RULES_DIR: join(isolatedCdpHome, 'rules'),
    };
    const help = runNpm(['run', '--silent', 'smoke:help'], { cwd: consumerDir, env: smokeEnvironment });
    assertIncludes(help.stdout, 'Usage: cdp [options] [command]', 'cdp-control --help');

    const kill = runNpm(['run', '--silent', 'smoke:kill'], { cwd: consumerDir, env: smokeEnvironment });
    assertIncludes(kill.stdout, '无 browser.json 配置,kill 不生效', 'cdp-control kill');

    const version = runNpm(['exec', '--yes=false', '--', 'cdp-control', '--version'], {
      cwd: consumerDir,
      env: smokeEnvironment,
    });
    assertIncludes(version.stdout, metadata.version, 'cdp-control --version');

    const cdpHomeEntries = readdirSync(isolatedCdpHome);
    if (cdpHomeEntries.length > 0) {
      throw new Error(`pack 冒烟污染了隔离 CDP_HOME: ${cdpHomeEntries.join(', ')}`);
    }

    summary = [
      `✅ npm pack 顶层白名单恰为: ${roots.join(', ')}`,
      `✅ npm install ${metadata.filename}: 安装目录顶层白名单一致`,
      '✅ cdp-control --help: exit 0 且命中 Usage 断言',
      '✅ cdp-control kill: exit 0 且空配置短路；CDP_NO_AUTOSTART=1，隔离 CDP_HOME 保持为空',
      `✅ cdp-control --version: 与 tarball 元数据版本 ${metadata.version} 一致`,
    ];
  } finally {
    rmSync(workspace, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }

  if (existsSync(workspace)) throw new Error(`pack 冒烟临时目录未清理: ${workspace}`);
  console.log([...summary, '✅ pack 冒烟临时目录与 tarball 已清理'].join('\n'));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
