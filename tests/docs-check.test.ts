import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { commanderContract, extractSkillClaims, validateSkillClaims } from '../scripts/docs-check.mjs';

function fixtureContract() {
  const root = new Command();
  root
    .command('view')
    .option('--tree', 'boolean flag')
    .option('--selector-file <file>', 'required value')
    .option('--format [kind]', 'optional value')
    .option('--ancestor <n>', 'shared flag')
    .option('--no-feedback', 'negated boolean');
  root.command('find').option('--text <text>').option('--selector <css>').option('--all');
  root.command('article');
  root.command('logs').option('--json');
  root.command('screenshot').option('--file <file>');
  root.command('extra').option('--actual-only');
  return commanderContract(root);
}

test('Commander 合同直接读取注册项，并区分 boolean、必填值与可选值 flag', () => {
  const contract = fixtureContract();
  const view = contract.commands.find(command => command.name === 'view');
  assert.deepEqual(view?.flags, [
    { name: '--tree', takesValue: false },
    { name: '--selector-file', takesValue: true },
    { name: '--format', takesValue: true },
    { name: '--ancestor', takesValue: true },
    { name: '--no-feedback', takesValue: false },
  ]);
});

test('SKILL 提取只覆盖明确 CLI 语法区，并保留命令上下文和值形态', () => {
  const markdown = [
    '## 感知页面(view)',
    '',
    '| 参数 | 作用 |',
    '|---|---|',
    '| `--tree` | 强制树 |',
    '| `--selector-file <f>` | selector |',
    '',
    '## Quick Reference',
    '',
    '| 子命令 | 作用 |',
    '|---|---|',
    '| `view [--tree] [--selector-file <f>]` | 感知 |',
    '| `find --text <关键词>` / `find --selector <css>` | 查找；`--all` 返回全部 |',
    '| `click <target> [--dom]` | 点击 |',
    '| `screenshot [--file out.png]` | 截图 |',
    '| `logs [--json]` | 日志 |',
    '',
    '| 共用参数 | 适用子命令 |',
    '|---|---|',
    '| `--target <匹配>` | `view` / `find` |',
    '',
    '```bash',
    'cdp-control view --selector-file region.txt',
    'cdp find --text needle',
    'cdp click --dom 44',
    'cdp click --dom <target>',
    '```',
    '',
    '```js',
    "await cdp.view(target, { selector: '--not-a-cli-flag' });",
    '```',
    '',
    '脚本 API：`cdp.read(target)`、`cdp.eval(target, "--not-an-inline-cli-flag")`、`window.__cdpProbe`、`api.fold(ref)`。',
    '通配说明：`--scroll-*`；散文中的真实 flag：`--all`。',
  ].join('\n');

  const claims = extractSkillClaims(markdown);
  assert.ok(claims.some(claim => claim.kind === 'command' && claim.command === 'view'));
  assert.ok(
    claims.some(
      claim =>
        claim.kind === 'flag' &&
        claim.command === 'view' &&
        claim.flag === '--selector-file' &&
        claim.takesValue === true,
    ),
  );
  assert.ok(
    claims.some(
      claim =>
        claim.kind === 'flag' && claim.command === 'screenshot' && claim.flag === '--file' && claim.takesValue === true,
    ),
  );
  assert.ok(
    claims.some(
      claim => claim.kind === 'flag' && claim.command === 'logs' && claim.flag === '--json' && !claim.takesValue,
    ),
  );
  assert.ok(
    claims.some(
      claim => claim.kind === 'flag' && claim.command === null && claim.flag === '--all' && claim.takesValue === null,
    ),
  );
  assert.ok(!claims.some(claim => claim.kind === 'flag' && claim.flag === '--not-a-cli-flag'));
  assert.ok(!claims.some(claim => claim.kind === 'flag' && claim.flag === '--not-an-inline-cli-flag'));
  assert.ok(!claims.some(claim => claim.kind === 'flag' && claim.flag.includes('*')));
  assert.ok(
    !claims.some(
      claim => claim.kind === 'command' && ['cdp.read', 'window.__cdpProbe', 'fold'].includes(claim.command),
    ),
  );
  assert.ok(
    claims.some(
      claim =>
        claim.kind === 'flag' && claim.command === 'view' && claim.flag === '--target' && claim.takesValue === true,
    ),
  );
  assert.ok(
    claims.some(
      claim =>
        claim.kind === 'flag' && claim.command === 'click' && claim.flag === '--dom' && claim.takesValue === null,
    ),
  );
  assert.equal(
    claims
      .filter(claim => claim.kind === 'flag' && claim.command === 'click' && claim.flag === '--dom')
      .some(claim => claim.takesValue === true),
    false,
  );
});

test('校验是单向的：Commander 多注册命令或 flag 不要求文档穷举', () => {
  const claims = extractSkillClaims('## Quick Reference\n\n| 子命令 | 作用 |\n|---|---|\n| `view [--tree]` | 树 |');
  assert.deepEqual(validateSkillClaims(fixtureContract(), claims), []);
});

test('不存在的命令、命令专属 flag 与 flag 值形态漂移都会失败', () => {
  const markdown = [
    '## Quick Reference',
    '',
    '| 子命令 | 作用 |',
    '|---|---|',
    '| `missing <url>` | 不存在 |',
    '| `article [--ancestor <n>]` | 此 flag 只在别的命令存在 |',
    '| `view [--tree <mode>] [--selector-file]` | 两种值形态都写反 |',
  ].join('\n');
  const errors = validateSkillClaims(fixtureContract(), extractSkillClaims(markdown));

  assert.ok(errors.some(error => error.code === 'unknown-command' && error.command === 'missing'));
  assert.ok(
    errors.some(
      error => error.code === 'unknown-command-flag' && error.command === 'article' && error.flag === '--ancestor',
    ),
  );
  assert.ok(errors.some(error => error.code === 'flag-value-shape' && error.flag === '--tree'));
  assert.ok(errors.some(error => error.code === 'flag-value-shape' && error.flag === '--selector-file'));
});

test('共用参数表把每个适用命令与 flag 关联，任一命令删 flag 都会失败', () => {
  const markdown = ['| 共用参数 | 适用子命令 |', '|---|---|', '| `--target <匹配>` | `view` / `find` |'].join('\n');
  const contract = fixtureContract();
  for (const command of contract.commands.filter(entry => ['view', 'find'].includes(entry.name))) {
    command.flags.push({ name: '--target', takesValue: true });
  }
  const claims = extractSkillClaims(markdown);
  assert.deepEqual(validateSkillClaims(contract, claims), []);

  const withoutFindTarget = {
    commands: contract.commands.map(command => ({
      ...command,
      flags: command.name === 'find' ? command.flags.filter(flag => flag.name !== '--target') : command.flags,
    })),
  };
  assert.ok(
    validateSkillClaims(withoutFindTarget, claims).some(
      error => error.code === 'unknown-command-flag' && error.command === 'find' && error.flag === '--target',
    ),
  );
});

test('共享行为章节把每个命令与所列 flag 关联，任一命令删 flag 都会失败', () => {
  const commands = ['click', 'fill', 'focus', 'hover', 'press-key'];
  const markdown = [
    '## 操作后自动反馈(click/fill/focus/hover/press-key 默认开启)',
    '',
    '- `--no-feedback`:关闭。`--feedback-delay <ms>`:自定义等待。',
  ].join('\n');
  const contract = {
    commands: commands.map(name => ({
      aliases: [],
      flags: [
        { name: '--no-feedback', takesValue: false },
        { name: '--feedback-delay', takesValue: true },
      ],
      name,
    })),
  };
  const claims = extractSkillClaims(markdown);
  assert.deepEqual(validateSkillClaims(contract, claims), []);

  for (const command of commands) {
    for (const flag of ['--no-feedback', '--feedback-delay']) {
      const drifted = {
        commands: contract.commands.map(entry => ({
          ...entry,
          flags: entry.name === command ? entry.flags.filter(option => option.name !== flag) : entry.flags,
        })),
      };
      assert.ok(
        validateSkillClaims(drifted, claims).some(
          error => error.code === 'unknown-command-flag' && error.command === command && error.flag === flag,
        ),
        `${command} 删除 ${flag} 必须变红`,
      );
    }
  }
});

test('位置参数消歧不依赖 Quick Reference 与 shell 示例的章节顺序', () => {
  const markdown = [
    '```bash',
    'cdp click --dom <target>',
    '```',
    '',
    '## Quick Reference',
    '',
    '| 子命令 | 作用 |',
    '|---|---|',
    '| `click <target> [--dom]` | 点击 |',
  ].join('\n');
  const claims = extractSkillClaims(markdown);
  assert.ok(
    claims.some(
      claim =>
        claim.kind === 'flag' && claim.command === 'click' && claim.flag === '--dom' && claim.takesValue === null,
    ),
  );
  assert.equal(
    claims
      .filter(claim => claim.kind === 'flag' && claim.command === 'click' && claim.flag === '--dom')
      .some(claim => claim.takesValue === true),
    false,
  );
});
