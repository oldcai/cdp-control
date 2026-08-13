import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import { discoverInstalledBrowsers, IntegrationHarness, REPO_ROOT, type CommandResult } from './harness.ts';
import { browserRequired } from '../integration-policy.ts';

const TARGET_MARKER = 'CDP Integration Fixture';

function assertSuccess(result: CommandResult, stage: string): void {
  assert.equal(result.code, 0, `${stage} 应成功\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function lineContaining(output: string, marker: string): string {
  const line = output.split(/\r?\n/).find(item => item.includes(marker));
  assert.ok(line, `输出中应包含 ${JSON.stringify(marker)}:\n${output}`);
  return line;
}

function refFromLine(line: string): number {
  const match = line.match(/\[ref=(\d+)/);
  assert.ok(match, `该行应含 ref: ${line}`);
  return Number(match[1]);
}

function jsonValue(output: string): unknown {
  return JSON.parse(output.trim()) as unknown;
}

function numberValue(output: string): number {
  const value = jsonValue(output);
  assert.equal(typeof value, 'number', `应输出 JSON number: ${output}`);
  return value as number;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${label} 应为对象`);
  return value as Record<string, unknown>;
}

test('本地 fixture 通过 headless 真浏览器走完整 CDP 链路', { timeout: 240_000 }, async t => {
  const discovery = discoverInstalledBrowsers();
  if (!discovery.available.length) {
    const reason = `未找到可用 Edge/Chrome/Chromium；已检查: ${discovery.checked.join(', ')}`;
    if (browserRequired()) assert.fail(`CI 集成测试禁止跳过：${reason}`);
    console.log(`SKIPPED: ${reason}`);
    t.skip(reason);
    return;
  }

  const harness = new IntegrationHarness(discovery.available);
  let inputRef = -1;
  let clickRef = -1;
  let recoveryRef = -1;
  let articleHeadingRef = -1;
  let initialView = '';

  try {
    await harness.start();
    const relativeHome = relative(join(REPO_ROOT, 'tmp'), harness.home);
    assert.ok(
      relativeHome && !relativeHome.startsWith('..') && !isAbsolute(relativeHome),
      `CDP_HOME 应位于项目 tmp/: ${harness.home}`,
    );
    assert.ok(harness.cdpPort >= 40_000, `CDP 端口应为高位端口: ${harness.cdpPort}`);
    assert.ok(![9222, 9223].includes(harness.cdpPort), '严禁使用 9222/9223');
    assert.ok(![9222, 9223].includes(harness.fixturePort), 'fixture 严禁使用 9222/9223');
    const config = harness.browserConfig();
    assert.equal(config.port, harness.cdpPort);
    assert.equal(config.userData, join(harness.home, 'user-data'));
    assert.ok(config.args.includes('--headless=new'), 'browser.json 必须明确开启 headless=new');
    assert.ok(existsSync(join(harness.home, 'browser.json')));
    assert.ok(existsSync(join(harness.home, 'rules', 'fold.csv')));
    assert.ok(existsSync(join(harness.home, 'rules', 'ignore-links.csv')));

    // URL token 在 target 创建时即可用，先按它等 DOM/标题就绪，避免慢 CI 上 list 看到(无标题)。
    await harness.waitForFixturePage();
    const listed = await harness.runCli(['list'], '准备：用 dist/cdp.js 连接浏览器');
    assertSuccess(listed, 'list');
    assert.match(listed.stdout, /共 \d+ 个 tab/);
    assert.match(listed.stdout, /CDP Integration Fixture/);

    await t.test('① view 建树包含 ref、输入框 value 与语义状态', { timeout: 30_000 }, async () => {
      const result = await harness.runCli(
        ['view', '--tree', '--scroll-to-load', '--scroll-wait', '0', '--target', TARGET_MARKER],
        '① view 建树',
      );
      assertSuccess(result, 'view');
      assert.match(result.stderr, /→ target: CDP Integration Fixture/);
      assert.match(result.stdout, /^# \[ref=i 状态\]=/);
      initialView = result.stdout;

      const inputLine = lineContaining(result.stdout, 'Fixture input');
      assert.match(inputLine, /input\[value="before" placeholder="Fixture input"\]/);
      inputRef = refFromLine(inputLine);

      const semanticLine = lineContaining(result.stdout, 'Semantic State');
      assert.match(semanticLine, /\[ref=\d+(?:·屏)?[^\]]*pressed/);
      assert.match(semanticLine, /expanded/);
      assert.match(semanticLine, /disabled/);
      refFromLine(semanticLine);

      clickRef = refFromLine(lineContaining(result.stdout, 'Trusted Coordinate Click'));
      recoveryRef = refFromLine(lineContaining(result.stdout, 'Recovery Target'));
      articleHeadingRef = refFromLine(lineContaining(result.stdout, 'Integration Heading'));
      assert.match(result.stdout, /FOLD_SECRET_SHOULD_HIDE/, '折叠规则写入前秘密文本应可见');
      assert.doesNotMatch(result.stdout, /Find Newly Added Reference/, '动态 find 目标初始应不存在');
    });

    await t.test('② find --text 为初始 view 后新增的 DOM 登记新 ref', { timeout: 30_000 }, async () => {
      const before = await harness.runCli(
        ['eval', '--target', TARGET_MARKER, 'window.__cdpRefs ? window.__cdpRefs.length : -1'],
        '② 读取 find 前 ref 数',
      );
      assertSuccess(before, 'find 前 ref 数');
      const beforeCount = numberValue(before.stdout);
      assert.ok(beforeCount > 0, '初始 view 应已建立 ref 表');

      const added = await harness.runCli(
        ['eval', '--target', TARGET_MARKER, 'window.fixtureAddFindTarget()'],
        '② 追加动态 DOM',
      );
      assertSuccess(added, '追加动态 DOM');
      assert.equal(jsonValue(added.stdout), true);

      const found = await harness.runCli(
        ['find', '--text', 'Find Newly Added Reference', '--target', TARGET_MARKER],
        '② find --text',
      );
      assertSuccess(found, 'find --text');
      const foundLine = lineContaining(found.stdout, 'Find Newly Added Reference');
      const foundRef = refFromLine(foundLine);

      const after = await harness.runCli(
        ['eval', '--target', TARGET_MARKER, 'window.__cdpRefs.length'],
        '② 读取 find 后 ref 数',
      );
      assertSuccess(after, 'find 后 ref 数');
      assert.equal(foundRef, beforeCount, '新 ref 应追加在原 ref 表尾部');
      assert.equal(numberValue(after.stdout), beforeCount + 1, 'find 只应新登记该目标一次');
    });

    await t.test('③ click 走坐标输入链，feedback 感知新增 DOM', { timeout: 30_000 }, async () => {
      assert.ok(clickRef >= 0, '必须先从 view 取得 click ref');
      const result = await harness.runCli(
        ['click', String(clickRef), '--feedback-delay', '80', '--target', TARGET_MARKER],
        '③ 坐标 click + feedback',
      );
      assertSuccess(result, 'click');
      assert.match(result.stdout, new RegExp(`已点击: ref=${clickRef} \\(button\\)`));
      assert.match(result.stdout, /selector 为: #trusted-click/);
      assert.match(result.stdout, /页面变化 · 新增内容:/);
      assert.match(
        result.stdout,
        /Trusted click observed: isTrusted=true/,
        'event.isTrusted=true 证明未退回 DOM el.click() 合成路径',
      );
    });

    await t.test('④ fill 后二次 view 回显最新 value', { timeout: 30_000 }, async () => {
      assert.ok(inputRef >= 0, '必须先从 view 取得 input ref');
      const filled = await harness.runCli(
        ['fill', String(inputRef), 'after fill', '--no-feedback', '--target', TARGET_MARKER],
        '④ fill',
      );
      assertSuccess(filled, 'fill');
      assert.match(filled.stdout, new RegExp(`已填入: ref=${inputRef} ← after fill`));

      const viewed = await harness.runCli(
        ['view', '--tree', '--scroll-to-load', '--scroll-wait', '0', '--target', TARGET_MARKER],
        '④ fill 后 view',
      );
      assertSuccess(viewed, 'fill 后 view');
      const line = lineContaining(viewed.stdout, 'value="after fill"');
      assert.equal(refFromLine(line), inputRef, '已登记元素应复用原 ref');
    });

    await t.test('⑤ 持久 fold 规则按 host/path/selector 命中并折叠子树', { timeout: 30_000 }, async () => {
      assert.match(initialView, /FOLD_SECRET_SHOULD_HIDE/);
      harness.writeFoldRule('1\t127.0.0.1\t/fixture\t#fold-region\tFixture folded region\n');
      const result = await harness.runCli(
        ['view', '--tree', '--scroll-to-load', '--scroll-wait', '0', '--target', TARGET_MARKER],
        '⑤ fold 规则命中',
      );
      assertSuccess(result, 'fold view');
      assert.match(result.stdout, /▸ \[ref=\d+(?:·屏)?\] Fixture folded region/);
      assert.doesNotMatch(result.stdout, /FOLD_SECRET_SHOULD_HIDE/, '命中 fold 后子树文本不应泄露到 view');
    });

    await t.test('⑥ DOM 删除后 stale ref 返回 refInvalid 与 recovered 局部视图', { timeout: 30_000 }, async () => {
      assert.ok(recoveryRef >= 0, '必须先从完整 view 取得 recovery ref');
      const removed = await harness.runCli(
        ['eval', '--target', TARGET_MARKER, `document.querySelector('#recovery-target').remove(); true`],
        '⑥ 删除 ref 对应 DOM',
      );
      assertSuccess(removed, '删除 recovery DOM');
      assert.equal(jsonValue(removed.stdout), true);

      const script = harness.writeTempScript(
        'recovery-check.js',
        `
const target = await cdp.resolve(${JSON.stringify(TARGET_MARKER)});
return await cdp.click(target, { ref: ${recoveryRef} }, { noFeedback: true });
`,
      );
      const raw = await harness.runCli(['run', script], '⑥ 断言 refInvalid/recovered 原始返回');
      assertSuccess(raw, 'recovery run');
      const recovery = recordValue(jsonValue(raw.stdout), 'recovery 返回');
      assert.equal(recovery.ok, false);
      assert.equal(recovery.refInvalid, true);
      const recovered = recordValue(recovery.recovered, 'recovered');
      assert.equal(typeof recovered.rootRef, 'number');
      assert.ok(Array.isArray(recovered.lines));
      assert.match((recovered.lines as unknown[]).join('\n'), /Recovery anchor survives/);
      assert.equal(recovery.feedback, null);

      const human = await harness.runCli(
        ['click', String(recoveryRef), '--no-feedback', '--target', TARGET_MARKER],
        '⑥ CLI 自愈回显',
      );
      assertSuccess(human, 'stale ref click');
      assert.match(human.stdout, /ref 失效 → 已自动 view 最近存活容器/);
      assert.match(human.stdout, /Recovery anchor survives/);
      assert.doesNotMatch(human.stdout, /已点击:/);
    });

    await t.test('⑦ article 以 ref 为根输出保序 Markdown', { timeout: 30_000 }, async () => {
      assert.ok(articleHeadingRef >= 0, '必须先从 view 取得 article 标题 ref');
      const result = await harness.runCli(
        ['article', String(articleHeadingRef), '--ancestor', '1', '--target', TARGET_MARKER],
        '⑦ article Markdown',
      );
      assertSuccess(result, 'article');
      assert.match(result.stdout, /^# Integration Heading/m);
      assert.match(result.stdout, /\[Example link\]\(https:\/\/example\.test\/docs\)/);
      assert.match(result.stdout, /\*\*bold\*\*/);
      assert.match(result.stdout, /\*italic\*/);
      assert.match(result.stdout, /^- First item$/m);
      assert.match(result.stdout, /^> Quote from fixture$/m);
      assert.match(result.stdout, /```\nconst answer = 42;\n```/);
    });

    await t.test('⑧ selector 不存在时非零退出且 stderr 清晰', { timeout: 30_000 }, async () => {
      const result = await harness.runCli(
        ['click', '#selector-does-not-exist', '--no-feedback', '--target', TARGET_MARKER],
        '⑧ selector 错误路径',
      );
      assert.equal(result.code, 1, `错误路径应退出 1:\n${result.stderr}`);
      assert.equal(result.stdout.trim(), '');
      assert.match(result.stderr, /→ target: CDP Integration Fixture/);
      assert.match(result.stderr, /错误: 未找到: #selector-does-not-exist/);
    });

    await t.test('⑨ 防呆放行的"像方言"selector,真浏览器确实认它们是合法 CSS', { timeout: 30_000 }, async () => {
      // selectorDialect 放行这些串的**理由**是"它们是合法 CSS,方言字样只是数据"。
      // 那条理由必须由真浏览器判,不能只由我们的单测自证 —— 这里让 querySelector 自己表态。
      // (2026-08:未掩码的防呆正则曾把前三条拒在 querySelector 之前,是真回归。)
      const probe = `(() => {
        const sels = [
          'input[value="text()"]',
          'a[href*="contains("]',
          '[aria-label="a >> b"]',
          'div >\\\\x> span',
          'div/* contains( */ > span',
          'div/* >>> */ span',
          '.a\\\\>\\\\>b',
          '/* c */ div',
          '.\\\\/foo',
          'div[data-x=y]',
          'svg text[x="1"]',
          'descendant::before',
          'self::part(name)',
          'parent::after'
        ];
        return sels.filter(s => { try { document.querySelector(s); return false; } catch { return true; } });
      })()`;
      const result = await harness.runCli(['eval', '--target', TARGET_MARKER, probe], '⑨ 真浏览器校验合法 CSS');
      assertSuccess(result, '真浏览器 querySelector 校验');
      assert.deepEqual(jsonValue(result.stdout), [], '这些串必须都是浏览器接受的合法 CSS');
    });
  } finally {
    const tempHome = harness.home;
    await harness.cleanup();
    if (tempHome) assert.equal(existsSync(tempHome), false, `临时 CDP_HOME 应已删除: ${tempHome}`);
  }
});
