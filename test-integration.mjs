// 跨平台集成测试入口：先 build 确保 dist 是最新用户产物，再显式收集 integration/*.test.ts。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [join(root, 'build.mjs')]);
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
run(process.execPath, [tsc, '--noEmit', '--project', join(root, 'tsconfig.integration.json')]);

const dir = join(root, 'tests', 'integration');
const files = readdirSync(dir)
  .filter(file => file.endsWith('.test.ts'))
  .sort()
  .map(file => join(dir, file));

if (!files.length) {
  console.error('没有集成测试文件');
  process.exit(1);
}

run(process.execPath, ['--test', '--experimental-strip-types', ...files]);
