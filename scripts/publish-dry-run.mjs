#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const INVALID_REGISTRY = 'https://registry.invalid/';
const ALLOWED_PREPARE = 'node build.mjs';
const STAGE_BUILD_SOURCE = 'build-source.mjs';
const BLOCKED_LIFECYCLE_HOOKS = Object.freeze([
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
]);
const STAGE_ENTRIES = Object.freeze([
  'LICENSE',
  'README.md',
  'build.mjs',
  'package.json',
  'rules',
  'skills',
  'src',
  'tsconfig.json',
]);

export function assertPublishChecklist(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('package.json 必须是对象');
  }
  if (manifest.private !== true) throw new Error('源 package.json 的 private 必须为 true');
  if (typeof manifest.name !== 'string' || !manifest.name) throw new Error('package.json 缺少 name');
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('package.json 缺少 version');

  const scripts = manifest.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    throw new Error('package.json 缺少 scripts');
  }
  if (scripts.prepare !== ALLOWED_PREPARE) {
    throw new Error(`prepare 必须恰为 ${JSON.stringify(ALLOWED_PREPARE)}`);
  }
  for (const hook of BLOCKED_LIFECYCLE_HOOKS) {
    if (Object.hasOwn(scripts, hook)) throw new Error(`禁止发布 lifecycle hook: ${hook}`);
  }
}

function credentialEnvironmentKey(key) {
  const normalized = key.toLowerCase();
  if (!normalized.startsWith('npm_config_')) {
    return ['auth', 'token', 'password', 'otp', 'username'].some(fragment => normalized.includes(fragment));
  }
  // npm_config_* can carry auth, client keys/certs, registry routing, or config-file paths.
  // Drop every inherited npm setting; only the isolated values below are admitted again.
  return true;
}

export function publishEnvironment(source, paths) {
  const forcedKeys = new Set([
    'home',
    'userprofile',
    'appdata',
    'localappdata',
    'npm_config_cache',
    'npm_config_dry_run',
    'npm_config_globalconfig',
    'npm_config_provenance',
    'npm_config_registry',
    'npm_config_userconfig',
  ]);
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || credentialEnvironmentKey(key) || forcedKeys.has(key.toLowerCase())) continue;
    environment[key] = value;
  }
  return {
    ...environment,
    APPDATA: paths.home,
    HOME: paths.home,
    LOCALAPPDATA: paths.home,
    USERPROFILE: paths.home,
    npm_config_cache: paths.cache,
    npm_config_dry_run: 'true',
    npm_config_globalconfig: paths.globalConfig,
    npm_config_provenance: 'false',
    npm_config_registry: INVALID_REGISTRY,
    npm_config_userconfig: paths.userConfig,
  };
}

/**
 * npm publish --json 会把 prepare 子进程的 stdout 和最终 JSON 都写到 npm stdout。
 * stage 保持 `prepare=node build.mjs`，但用这个临时包装器执行原 build，并把两条输出流都接到 fd 2。
 * 这样最终 JSON 与任意构建日志物理分流，不需要猜 JSON 在混合文本中的边界。
 */
export function stagePrepareWrapperSource() {
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stageDir = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [join(stageDir, '${STAGE_BUILD_SOURCE}')], {
  cwd: stageDir,
  shell: false,
  stdio: ['inherit', 2, 2],
});
if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
`;
}

function npmCliPath() {
  if (!process.env.npm_execpath) {
    throw new Error('缺少 npm_execpath；请通过 `npm run publish:dry-run` 执行，以保证 Windows 也使用正确的 npm CLI');
  }
  return process.env.npm_execpath;
}

function runNpm(args, options) {
  const result = spawnSync(process.execPath, [npmCliPath(), ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
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

export function parseDryRunMetadata(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`stdout 必须只包含 publish JSON，无法解析: ${message}\n${stdout}`);
  }
  return parsed;
}

function assertDryRunMetadata(stdout, name, version) {
  const parsed = parseDryRunMetadata(stdout);
  const serialized = JSON.stringify(parsed);
  if (!serialized.includes(name) || !serialized.includes(version)) {
    throw new Error(`publish dry-run 元数据未包含 ${name}@${version}:\n${stdout}`);
  }
}

function main() {
  const packagePath = join(repoRoot, 'package.json');
  const sourceBytes = readFileSync(packagePath);
  const sourceManifest = JSON.parse(sourceBytes.toString('utf8'));
  assertPublishChecklist(sourceManifest);
  if (!existsSync(join(repoRoot, 'node_modules'))) throw new Error('缺少 node_modules；请先运行 npm install');

  const tmpRoot = join(repoRoot, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const workspace = mkdtempSync(join(tmpRoot, 'publish-dry-run-'));
  const stage = join(workspace, 'stage');
  const isolatedHome = join(workspace, 'home');
  const cache = join(workspace, 'npm-cache');
  const userConfig = join(workspace, 'user.npmrc');
  const globalConfig = join(workspace, 'global.npmrc');
  const stageNodeModules = join(stage, 'node_modules');
  let linkedNodeModules = false;
  let completed = false;

  try {
    mkdirSync(stage);
    mkdirSync(isolatedHome);
    mkdirSync(cache);
    writeFileSync(userConfig, '\n');
    writeFileSync(globalConfig, '\n');
    for (const entry of STAGE_ENTRIES) {
      cpSync(join(repoRoot, entry), join(stage, entry), { errorOnExist: true, recursive: true });
    }
    renameSync(join(stage, 'build.mjs'), join(stage, STAGE_BUILD_SOURCE));
    writeFileSync(join(stage, 'build.mjs'), stagePrepareWrapperSource());

    const stageManifest = {
      ...sourceManifest,
      private: false,
      publishConfig: {
        provenance: false,
        registry: INVALID_REGISTRY,
      },
    };
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(stageManifest, null, 2)}\n`);
    if (JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')).private !== false) {
      throw new Error('临时发布 stage 未成功翻转 private=false');
    }

    symlinkSync(join(repoRoot, 'node_modules'), stageNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
    linkedNodeModules = true;

    const environment = publishEnvironment(process.env, {
      cache,
      globalConfig,
      home: isolatedHome,
      userConfig,
    });
    const result = runNpm(
      ['publish', '--dry-run', '--loglevel=error', '--json', '--registry', INVALID_REGISTRY, '--provenance=false'],
      { cwd: stage, env: environment },
    );
    assertDryRunMetadata(result.stdout, sourceManifest.name, sourceManifest.version);
    completed = true;
  } finally {
    try {
      if (linkedNodeModules && existsSync(stageNodeModules)) {
        if (!lstatSync(stageNodeModules).isSymbolicLink()) {
          throw new Error(`拒绝单独 unlink 非符号链接 node_modules: ${stageNodeModules}`);
        }
        unlinkSync(stageNodeModules);
      }
    } finally {
      rmSync(workspace, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  }

  if (!completed) throw new Error('publish dry-run 未完成');
  if (existsSync(workspace)) throw new Error(`publish dry-run 临时目录未清理: ${workspace}`);
  if (!readFileSync(packagePath).equals(sourceBytes)) throw new Error('源 package.json 在演练中发生变化');
  console.log(
    [
      `✅ 发布 checklist: 源 ${sourceManifest.name}@${sourceManifest.version} 保持 private=true`,
      `✅ 临时 stage: private=false；发布 lifecycle 仅允许 prepare=${JSON.stringify(ALLOWED_PREPARE)}`,
      `✅ npm publish --dry-run: exit 0；registry 固定为 ${INVALID_REGISTRY}`,
      '✅ npm 凭据环境已过滤，HOME/npmrc/cache 全部隔离',
      '✅ 源 package.json 未改，临时 stage 已清理；未执行真实发布',
    ].join('\n'),
  );
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
