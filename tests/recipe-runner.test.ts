/**
 * recipe-runner.test.ts — 站点 recipe 匹配 + 共享 _lib 工具单测。
 * 验证 L0 站点聚合:
 *   同文件多条规则(不同 layout)、一规则多形态 scope(数组)、跨文件规则级全序匹配。
 * 用 CDP_RULES_DIR 指到临时目录写入假 recipe,避免碰真实 rules/。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { matchRecipe } from '../src/recipe-runner.ts';

const require = createRequire(import.meta.url);

/** 在临时 rules/recipes 下写入若干 recipe 文件,跑完清理。
 * P-4 后 recipe 直接读 git 权威 rules/recipes/(经 CDP_RULES_DEFAULT_DIR 覆盖指向临时目录),
 * 故用 CDP_RULES_DEFAULT_DIR 指到临时目录、recipe 落 <dir>/recipes。 */
async function withRecipes(files: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-recipe-'));
  const prev = process.env.CDP_RULES_DEFAULT_DIR;
  process.env.CDP_RULES_DEFAULT_DIR = dir;
  const recipesDir = join(dir, 'recipes');
  mkdirSync(recipesDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(recipesDir, name), body);
  try {
    await fn();
  } finally {
    process.env.CDP_RULES_DEFAULT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

const mkRule = (name: string, scope: string | string[], extract = 'async () => ({ lines: [""] })') =>
  `{ name: ${JSON.stringify(name)}, scope: ${JSON.stringify(scope)}, extract: ${extract} }`;

test('同文件多规则:不同 scope 各命中各自的 extract 名', async () => {
  await withRecipes(
    {
      'zhihu.js': `module.exports = [
      ${mkRule('问题页', 'www.zhihu.com/question/*', 'async () => ({ lines: ["question"] })')},
      ${mkRule('专栏', 'zhuanlan.zhihu.com/p/*', 'async () => ({ lines: ["zhuanlan"] })')},
    ];`,
    },
    async () => {
      const q = await matchRecipe('https://www.zhihu.com/question/123');
      const z = await matchRecipe('https://zhuanlan.zhihu.com/p/5678');
      assert.equal(q!.rule.name, '问题页');
      assert.equal(z!.rule.name, '专栏');
    },
  );
});

test('一规则多形态 scope(数组):任一形态命中即该规则', async () => {
  await withRecipes(
    {
      'site.js': `module.exports = [
      { name: '同布局两形态', scope: ['a.example.com/p/*', 'b.example.com/*'], extract: async () => ({ lines: ["x"] }) },
    ];`,
    },
    async () => {
      const a = await matchRecipe('https://a.example.com/p/1');
      const b = await matchRecipe('https://b.example.com/2');
      const c = await matchRecipe('https://c.example.com/3');
      assert.equal(a!.rule.name, '同布局两形态');
      assert.equal(b!.rule.name, '同布局两形态');
      assert.equal(c, null);
    },
  );
});

test('主机名字面量:www 通配不会跨子域吞 zhuanlan', async () => {
  await withRecipes(
    {
      'zhihu.js': `module.exports = [
      ${mkRule('www宽', 'www.zhihu.com/*')},
    ];`,
    },
    async () => {
      // 主机名字面量 glob:www.zhihu.com/* 只匹配 www,不吞 zhuanlan 子域
      const w = await matchRecipe('https://www.zhihu.com/question/1');
      const z = await matchRecipe('https://zhuanlan.zhihu.com/p/2');
      assert.equal(w!.rule.name, 'www宽');
      assert.equal(z, null);
    },
  );
});

test('跨文件规则级全序:通配符最少 → scope 更长 → 声明顺序', async () => {
  await withRecipes(
    {
      'a.js': `module.exports = [
      ${mkRule('宽泛', 'example.com/*')},
    ];`,
      'b.js': `module.exports = [
      ${mkRule('精确', 'example.com/p/*')},
    ];`,
    },
    async () => {
      const m = await matchRecipe('https://example.com/p/1');
      // 两者通配符数相同(各 1 个 *),按 scope 更长 tiebreak → 精确(example.com/p/*)胜
      assert.equal(m!.rule.name, '精确');
      assert.equal(m!.file, 'b.js');
    },
  );
});

// ────────────────────────── _lib.js 共享工具 ──────────────────────────
test('_lib clean:剥零宽/扁平空白/去首尾', () => {
  const { clean } = require('../rules/recipes/_lib.js');
  assert.equal(clean('  a\n b ​ c  '), 'a b c');
  assert.equal(clean(undefined), '');
});

test('_lib refstr/opHint:null 与负数均返回空串,有效 ref 才上标', () => {
  const { refstr, opHint } = require('../rules/recipes/_lib.js');
  assert.equal(refstr(null), '');
  assert.equal(refstr(-1), '');
  assert.equal(refstr(74), ' [ref=74]');
  assert.equal(opHint('view', null), '');
  assert.equal(opHint('view', 74), '(用 view 74 展开)');
});

test('_lib abridge:归一化 + 截断 + 补省略号;不足不截', () => {
  const { abridge } = require('../rules/recipes/_lib.js');
  assert.equal(abridge('  a\n b  c '), 'a b c'); // 短文本:只归一化,不截
  const long = 'x'.repeat(200);
  assert.equal(abridge(long, 160).length, 160 + 1); // 超长截 160 + '…'
  assert.equal(abridge(long, 160).endsWith('…'), true);
  assert.equal(abridge('a​b', 160), 'ab'); // 剥零宽
});

test('_lib entry:label + clean(value) + refstr(ref);站点整形不下沉', () => {
  const { entry } = require('../rules/recipes/_lib.js');
  assert.equal(entry({ value: '  赞同 1.5 万​ ', ref: 7 }), '赞同 1.5 万 [ref=7]');
  assert.equal(entry({ label: '作者:', value: '柳下风来', ref: 3 }), '作者:柳下风来 [ref=3]');
  assert.equal(entry({ value: '裸数字', ref: null }), '裸数字'); // 无 label 无 ref
});
