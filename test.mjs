// 跨平台测试入口:node 支持 --test 但目录/glob 在 cmd 下不可靠,这里显式收集 *.test.ts 传给 node --test。
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, 'tests');
const files = readdirSync(dir)
  .filter(f => f.endsWith('.test.ts'))
  .map(f => join(dir, f));
if (!files.length) {
  console.error('没有测试文件');
  process.exit(1);
}
try {
  execSync(`node --test --experimental-strip-types ${files.map(f => `"${f}"`).join(' ')}`, { stdio: 'inherit' });
} catch {
  process.exit(1);
}
