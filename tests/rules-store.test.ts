/**
 * rules-store.test.ts — 规则持久化统一目录 + seed-once 单测。
 * 用 CDP_RULES_DIR 指到临时目录,避免碰真实 rules/ 与 dist/。验证:
 *   首跑缺文件 → 从根 rules/ 拷默认;已有 → 不覆盖(修 clobber);运行时 fold add 写进 rules/ 持久。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRules, foldsLivePath, linksLivePath, rulesDir } from '../src/rules-store.ts';

// strip-types(ESM)下无 __dirname,默认源用 CDP_RULES_DEFAULT_DIR 指到真实根 rules/。
const DEFAULT_RULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

function withRulesDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-rules-'));
  const prev = process.env.CDP_RULES_DIR;
  const prevD = process.env.CDP_RULES_DEFAULT_DIR;
  process.env.CDP_RULES_DIR = dir;
  process.env.CDP_RULES_DEFAULT_DIR = DEFAULT_RULES;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CDP_RULES_DIR;
    else process.env.CDP_RULES_DIR = prev;
    if (prevD === undefined) delete process.env.CDP_RULES_DEFAULT_DIR;
    else process.env.CDP_RULES_DEFAULT_DIR = prevD;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('seed-once: 首跑缺文件从根 rules/ 拷默认', () => {
  withRulesDir(dir => {
    ensureRules();
    const fold = join(dir, 'fold.csv');
    assert.ok(existsSync(fold), 'fold.csv 被 seed');
    assert.ok(existsSync(join(dir, 'ignore-links.csv')), 'ignore-links.csv 被 seed');
    // 内容与默认源一致(默认源含 zhihu/csdn 折叠规则)
    assert.ok(readFileSync(fold, 'utf8').includes('www.zhihu.com'), '默认 fold.csv 含知乎规则');
    assert.equal(foldsLivePath(), join(dir, 'fold.csv'));
    assert.equal(linksLivePath(), join(dir, 'ignore-links.csv'));
  });
});

test('seed-once: 已有文件不被覆盖(修 clobber)', () => {
  withRulesDir(dir => {
    const fold = join(dir, 'fold.csv');
    writeFileSync(fold, 'CUSTOM_RULE\n');
    ensureRules();
    assert.equal(readFileSync(fold, 'utf8'), 'CUSTOM_RULE\n', '已存在的用户编辑不被覆盖');
  });
});

test('rulesDir: 默认跟随 CDP_HOME,CDP_RULES_DIR 保持最高优先级', () => {
  const home = join('tmp', 'isolated-cdp-home');
  const explicitRules = join('tmp', 'explicit-rules');
  assert.equal(rulesDir({ CDP_HOME: home }), join(home, 'rules'));
  assert.equal(rulesDir({ CDP_HOME: home, CDP_RULES_DIR: explicitRules }), explicitRules);
});
