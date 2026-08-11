/**
 * cdp.ts — 通过 CDP 控制本地浏览器的脚本入口(commander CLI)。
 * 编译产物为 dist/cdp.js(esbuild bundle,含 commander,dist 自包含)。
 * 运行 `node dist/cdp.js <子命令>`;require 本文件时导出 api。
 */
import { program } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { coreApi } from './api';
import { logs, cmdListen } from './monitor';
import { ensureBrowser, killBrowser } from './browser';
import { runScript } from './run-script';
import { runRecipe } from './recipe-runner';

const api: any = { ...coreApi, logs, ensure: ensureBrowser, kill: killBrowser };
// recipe:暴露给 run 脚本显式取站点摘要(命中返回 {lines},未命中 null)。
api.recipe = async (target: any, opts: any) => runRecipe(target.url, api, target, opts);

/**
 * view/fetch 共用的感知分发:默认跑命中 recipe(站点摘要),未命中或用户表达建树意图 → 纯结构树。
 * 建树意图(强制树)= --tree / 位置 ref / --selector-file / --visible-only / --scroll-* 任一。
 * 分发在 CLI action 顶层,`api.view` 保持纯结构(fetchPage/操作反馈内部照旧用,无递归)。
 */
async function dispatchView(target: any, opts: any): Promise<{ lines: string[]; recipe: boolean }> {
  const treeIntent = !!opts.tree || opts.ref != null || opts.selector != null || !!opts.visibleOnly || !!opts.scrollToLoad;
  if (!treeIntent) {
    const d = await runRecipe(target.url, api, target, opts);
    if (d) return { lines: d.lines, recipe: true };
  }
  const r = await api.view(target, opts);
  return { lines: r.lines ?? [], recipe: false };
}

/** view 输出顶部图例(解释各标记,Agent 易跳过、不误当内容;只加在 view 命令顶层,反馈/自愈块不加)。 */
const VIEW_LEGEND = '# [ref=i]=可操作索引 · [ref=i,visible]=当前视口内 · ~"…"=聚合文本 · ▸=已折叠(括号内为隐藏元素数,view <ref> 展开) · [shadow]=shadow DOM';
/** recipe 摘要输出顶部图例(复用 [ref=N] 约定,让 ref 自解释)。 */
const RECIPE_LEGEND = '# 站点摘要(recipe 命中)· [ref=N]=可操作索引(可 click/fill/article 等按需展开)';

/** 读 --selector-file 内容(去首尾空白)。 */
function readOptFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try { return readFileSync(file, 'utf8').trim(); }
  catch (e: any) { throw new Error(`读取参数文件失败: ${file} — ${e.message}`); }
}

/** 带 target 的命令统一拿目标并打印提示。target 为该命令 option 解析出的值。 */
async function needTarget(target?: string): Promise<any> {
  const t = await api.resolve(target ?? undefined);
  console.error(`→ target: ${t.title || ''} ${t.url}`);
  return t;
}

/** 需要 target 的命令模板:给子命令挂 --target option。 */
function targetCmd(name: string, desc: string) {
  return program.command(name).description(desc).option('-t, --target <匹配>', '目标 tab(id/url/title 子串)');
}

// —— 不需要 target 的命令 ——
program
  .name('cdp')
  .version('1.0.0')
  .description('CDP 浏览器控制(取代 chrome-devtools MCP)');

program.command('list').description('确保浏览器就绪并列出所有 page tab(含手动开的);第一项为前台 tab(← 前台)')
  .action(async () => {
    const list = await api.list(); // api.list 已在 api 层前置 ensure(未起自动启动,就绪零开销)。
    console.log(`共 ${list.length} 个 tab(第一项 = 前台):`);
    if (list.length === 0) return;
    const line = (t: any, i: number) => `${t.id.slice(0, 8)}  ${t.title || '(无标题)'}  ${t.url}${i === 0 ? '  ← 前台' : ''}`;
    console.log(list.map((t: any, i: number) => `${i + 1}. ${line(t, i)}`).join('\n'));
  });

program.command('open').argument('<url>', '要打开的网址').description('新开一个 tab')
  .action(async (url) => { const tid = await api.open(url || 'about:blank'); console.log(`已打开: ${url}\ntargetId: ${tid.slice(0, 8)}`); });

program.command('kill').description('强制结束 browser.json 指定端口上的浏览器进程并等端口释放(无配置则 kill 不生效)')
  .action(async () => {
    const r = await api.kill();
    if (r.reason === 'noConfig') console.log('无 browser.json 配置,kill 不生效');
    else if (r.reason === 'broken') console.log('browser.json 配置损坏,无法确定端口,kill 不生效');
    else if (r.ok) console.log(`已强制结束浏览器 (端口 ${r.port} 已释放)`);
    else if (r.reason === 'stillUp') console.log(`端口 ${r.port} 仍有进程(Edge 可能崩溃自启),kill 未完全生效`);
    else console.log(`端口 ${r.port} 上无浏览器进程`);
  });

program.command('close').argument('<target>', '目标匹配').description('关闭 tab')
  .action(async (tgt) => { const t = await api.resolve(tgt); await api.close(t); console.log(`已关闭: ${t.title || t.url}`); });

program.command('activate').argument('<target>', '目标匹配').description('把指定 tab 拉到前台')
  .action(async (tgt) => { const t = await api.resolve(tgt); await api.activate(t); console.log(`已激活: ${t.title || t.url}`); });

program.command('fetch').argument('<url>', '要抓取的网址').description('一次性抓取页面:ensure → 临时开 tab 打开 url → 感知(命中 recipe 输出摘要,否则建树) → 关闭 tab(替代 web fetch MCP)')
  .action(async (url) => {
    const tid = await api.open(url || 'about:blank'); // api.open 已在 api 层前置 ensure。
    let t: any;
    try {
      t = await api.resolve(tid);
      try { await api.waitForFn(t, 'document.body && document.body.innerText.trim().length > 0', { timeout: 20000, interval: 300 }); } catch {}
      const d = await dispatchView(t, {}); // 裸 fetch → recipe 摘要优先
      if (!d.lines.length) { console.log('(空树)'); return; }
      console.log((d.recipe ? RECIPE_LEGEND : VIEW_LEGEND) + '\n' + d.lines.join('\n'));
    } finally {
      if (t) { try { await api.close(t); } catch {} }
    }
  });

// 隐藏命令:内部 daemon 自重生入口(cmdListen)。用户不直接调——监听 daemon 由 open/ensure/logs
// 自动拉起,浏览器关闭后看门狗自退,无需手动 listen/listen-stop 管理(见 SKILL「读控制台日志」)。
program.command('__daemon', { hidden: true }).description('(内部)控制台监听注入守护')
  .action(async () => { await cmdListen(); });

program.command('run').argument('<file>', '脚本文件').description('执行自动化脚本(脚本里用全局 cdp API,可顶层 await;返回非 undefined 则打印)')
  .action(async (file) => {
    const abs = pathResolve(file); const code = readFileSync(abs, 'utf8');
    (globalThis as any).cdp = api;
    const r = await runScript(code, api);
    if (r !== undefined) console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
  });

// —— 需要 target 的命令(每个挂 --target option,action 末参为 opts,含 opts.target) ——
targetCmd('navigate', '导航到 url').argument('<url>', '网址')
  .action(async (url, opts) => { await api.navigate(await needTarget(opts.target), url); console.log(`已导航到: ${url}`); });

targetCmd('eval', '在页面执行 JS,返回 JSON 值').argument('<js...>', '要执行的 JS')
  .action(async (js, opts) => { const code = (js as string[]).join(' '); console.log(JSON.stringify(await api.eval(await needTarget(opts.target), code), null, 2)); });

targetCmd('view', '感知:命中 recipe 输出站点摘要,否则整页结构树(建树意图任一带--tree/位置ref/--selector-file/--visible-only/--scroll-* 则强制树)')
  .argument('[n]', 'view 输出的 ref 序号建视图根(不传则从根 body 建树;与 --selector-file 二选一;给了即强制树)')
  .option('--tree', '强制结构树(即便命中 recipe 也建树)')
  .option('--ancestor <n>', '从建视图根向上爬 N 层父级再建视图(默认 0;与 ref/selector 任一锚点配合)')
  .option('--selector-file <file>', '从文件读 selector')
  .option('--visible-only', '只输出当前视口内几何可见且非隐藏(display:none/opacity:0)的元素,模拟 agent 看到的当前屏幕;视口外的祖先退化为纯容器骨架')
  .option('--scroll-to-load', '先滚动触发懒加载(评论区等首屏外的内容)再建视图——模拟真实用户滚动,防 agent 找不到未加载区域(默认 ±1 屏回弹)')
  .option('--scroll-pages <n>', '与 --scroll-to-load 配合:循环向下滚 N 屏(边滚边检测 scrollHeight 增长,连续 2 次不增长提前停),用于无限流')
  .option('--scroll-to <selector>', '与 --scroll-to-load 配合:先滚到匹配该 selector 的元素(如 B站评论区 #bili-comments),命中不到优雅降级')
  .option('--scroll-wait <ms>', '与 --scroll-to-load 配合:滚动触发懒加载后等待内容渲染的毫秒数(默认 1000;调大给新回答/评论区更多加载时间)')
  .option('--max-len <n>', '文本截断阈值(字符数);缺省不截断,设值则所有文本片截到 n 并补省略号')
  .action(async (n, opts) => {
    const sel = readOptFile(opts.selectorFile);
    const ref = n != null ? Number(n) : undefined;
    if (ref != null && sel) throw new Error('ref 序号与 --selector-file 只能选其一');
    if ((opts.scrollPages != null || opts.scrollTo != null) && !opts.scrollToLoad) {
      throw new Error('--scroll-pages / --scroll-to 必须与 --scroll-to-load 配合使用');
    }
    const target = await needTarget(opts.target);
    const d = await dispatchView(target, {
      tree: !!opts.tree, selector: sel, visibleOnly: !!opts.visibleOnly,
      ref,
      ancestor: opts.ancestor != null ? Number(opts.ancestor) : undefined,
      scrollToLoad: !!opts.scrollToLoad,
      scrollPages: opts.scrollPages != null ? Number(opts.scrollPages) : undefined,
      scrollTo: opts.scrollTo || undefined,
      scrollWait: opts.scrollWait != null ? Number(opts.scrollWait) : undefined,
      maxLen: opts.maxLen != null ? Number(opts.maxLen) : undefined,
    });
    if (!d.lines.length) { console.log('(空树)'); return; }
    console.log((d.recipe ? RECIPE_LEGEND : VIEW_LEGEND) + '\n' + d.lines.join('\n'));
  });

// 操作目标:位置参数 <target> 全数字→ref(配 --ancestor),否则视为 selector。见 api.TargetArg。
function normTarget(t: string, ancestor: string | number | undefined): string | { ref: number; ancestor?: number } {
  if (/^\d+$/.test(t)) return { ref: Number(t), ancestor: ancestor != null ? Number(ancestor) : undefined };
  return t;
}
const targetOpt = (c: any) => c
  .option('--ancestor <n>', '按 ref 定位后向上爬 N 层父级再操作(默认 0;把内容叶子抬到区域容器;仅对数字 ref 生效)');

/** 操作后自动反馈 option(click/fill/focus/hover/press-key 共用)。默认开启,等 feedbackDelay 后回报新增内容 + tab 变化。 */
const feedbackOpt = (c: any) => c
  .option('--no-feedback', '关闭操作后自动反馈(不等待、不观察、不 diff tab)')
  .option('--feedback-delay <ms>', '操作后等待时长,毫秒(默认 1000;给异步/懒加载内容出现留时间)', (v: string) => parseInt(v, 10), 1000);

/** 组装反馈配置(供 api 动作方法):--no-feedback 或 --feedback-delay。
 * 注意 commander 的 `--no-feedback` 生成布尔 option 名为 `feedback`(默认 true,传 --no-feedback 时 false)。 */
const feedbackCfg = (opts: any): { noFeedback: boolean; feedbackDelay: number } => ({
  noFeedback: opts.feedback === false,
  feedbackDelay: opts.feedbackDelay != null ? Number(opts.feedbackDelay) : 1000,
});

/**
 * ref 失效自愈的三态文案(共享:click/fill/focus/hover/locate/fold 失效都走这套)。
 *  - 从未存在(agent 打错号):提示检查 ref 号,不走自愈(别误导成"页面刷新")。
 *  - 失效但找到存活祖先:打印最近存活容器 + 局部 view,提示用新 ref 重试。
 *  - 整链 detached(页面刷新/重建):提示重新 view。
 * 返回是否已打印(调用方据此跳过自己的正常输出)。
 */
function printRefInvalid(r: any): boolean {
  if (!r?.refInvalid) return false;
  const rec = r.recovered;
  if (rec?.never) {
    console.log(`ref 失效: ${rec.msg}`);
  } else if (rec) {
    console.log(`ref 失效 → 已自动 view 最近存活容器 [ref=${rec.rootRef}],用里面的新 [ref] 重试:`);
    console.log(rec.lines.join('\n'));
  } else {
    console.log('ref 失效: 整条祖先链均已失效(页面可能已刷新/重建),请重新 view 拿新 ref');
  }
  return true;
}

/** 操作结果行 + 附唯一 selector(同一行,逗号分隔)。后续对该元素操作优先用此 selector,避免 ref 失效。
 * selector 超长截断(位置链常很长);shadow 内元素不返回 selector,提示用 ref 操作。
 * ref 失效自愈:打印"最近存活容器 + 局部 view",提示 agent 用里面的新 ref 重试(不打印"已操作")。 */
function printAction(line: string, r: any): void {
  if (printRefInvalid(r)) return;
  if (r?.shadow) {
    console.log(line + ' （该元素在 shadow 内,继续用 ref 操作)');
  } else {
    const sel = r?.selector;
    const shown = sel ? (sel.length > 80 ? sel.slice(0, 80) + '…' : sel) : '';
    console.log(line + (shown ? ` ，该元素的 selector 为: ${shown}` : ''));
  }
}

/** 打印操作反馈:新增内容 / 文本变化 / tab 变化分块,内容 2 空格缩进。fb 为 null(--no-feedback)时无输出。 */
function printFeedback(fb: any): void {
  if (!fb) return;
  const out: string[] = [];
  if (fb.note) out.push(fb.note);
  if (fb.blocks?.length) {
    out.push('页面变化 · 新增内容:');
    for (const b of fb.blocks) {
      for (const l of b.lines) out.push('  ' + l);
      if (b.count > 1) out.push(`  (重复 ${b.count} 次,已折叠)`);
    }
  }
  if (fb.changes?.length) {
    out.push('页面变化 · 文本变化:');
    for (const c of fb.changes) out.push('  · ' + (c.before ? `${c.before} → ${c.after}` : `"${c.after}"`));
  }
  if (fb.tabs?.opened?.length) {
    out.push('新开 tab:');
    for (const t of fb.tabs.opened) out.push('  · ' + `${t.title || t.url} [${t.id.slice(0, 8)}]`);
  }
  if (fb.tabs?.closed?.length) {
    out.push('关闭 tab:');
    for (const t of fb.tabs.closed) out.push('  · ' + (t.title || t.url));
  }
  if (fb.tabs?.navigated?.length) {
    out.push('跳转 tab:');
    for (const n of fb.tabs.navigated) out.push('  · ' + `${n.to} [${n.id.slice(0, 8)}]` + (n.from ? ` (原 ${n.from})` : ''));
  }
  if (out.length) console.log(out.join('\n'));
}

/** 日志用目标描述:selector 或 ref=12(↑3 表示爬 3 层父)。 */
const argLabel = (a: string | { ref: number; ancestor?: number }): string =>
  typeof a === 'string' ? a : 'ref=' + a.ref + (a.ancestor ? `↑${a.ancestor}` : '');

/** info 结果(祖先链)格式化:逐层 tag#id.class[data-*][aria][role],根→叶,末尾附目标层号与建议 selector。 */
function printInfoChain(r: any): void {
  if (!r?.chain?.length) { console.log('(空链)'); return; }
  for (const l of r.chain) {
    const parts: string[] = [`depth ${l.depth}: ${l.tag}`];
    if (l.ref != null) parts.push('[ref=' + l.ref + ']');
    if (l.id) parts.push('#' + l.id);
    if (l.classes) parts.push('.' + (Array.isArray(l.classes) ? l.classes.join('.') : String(l.classes)));
    if (l.dataAttrs) for (const [k, v] of Object.entries(l.dataAttrs)) parts.push(`[${k}="${v}"]`);
    if (l.aria) parts.push(`[aria="${l.aria}"]`);
    if (l.role) parts.push(`[role="${l.role}"]`);
    if (l.title) parts.push(`[title="${l.title}"]`);
    console.log(parts.join(' '));
  }
  if (r.targetDepth != null) console.log(`→ 目标在第 ${r.targetDepth} 层`);
  if (r.suggested) console.log(`建议 selector: ${r.suggested}`);
}

feedbackOpt(targetOpt(targetCmd('click', '点击元素')))
  .argument('<target>', 'ref 序号或 selector(全数字=ref)')
  .option('--dom', '显式使用旧 DOM 合成点击(isTrusted:false),仅作 fixed 布局逃生舱')
  .action(async (t: string, opts: { ancestor?: string | number; target?: string; feedback?: boolean; feedbackDelay?: number; dom?: boolean }) => {
    const arg = normTarget(t, opts.ancestor);
    const r = await api.click(await needTarget(opts.target), arg, { ...feedbackCfg(opts), dom: !!opts.dom });
    printAction(`已点击: ${argLabel(arg)} (${r.tag})`, r);
    printFeedback(r.feedback);
  });

feedbackOpt(targetOpt(targetCmd('fill', '填输入框并触发 input/change'))).argument('<target>', 'ref 序号或 selector(全数字=ref)').argument('<value>', '值')
  .action(async (t: string, val: string, opts: any) => { const arg = normTarget(t, opts.ancestor); const r = await api.fill(await needTarget(opts.target), arg, val, feedbackCfg(opts)); printAction(`已填入: ${argLabel(arg)} ← ${val}`, r); printFeedback(r.feedback); });

feedbackOpt(targetOpt(targetCmd('focus', '聚焦元素'))).argument('<target>', 'ref 序号或 selector(全数字=ref)')
  .action(async (t: string, opts: any) => { const arg = normTarget(t, opts.ancestor); const r = await api.focus(await needTarget(opts.target), arg, feedbackCfg(opts)); printAction(`已聚焦: ${argLabel(arg)} (${r.tag})`, r); printFeedback(r.feedback); });

targetCmd('get-focus', '查看当前焦点元素在哪')
  .action(async (opts) => { const f = await api.getFocus(await needTarget(opts.target)); if (!f) { console.log('(当前无焦点元素)'); return; } console.log(`焦点在: [${f.tag}] "${f.text || ''}" ${f.id ? '#' + f.id : ''} sel=${f.selector}`); });

targetCmd('info', '列目标元素祖先链(tag/id/class/语义 data-*/aria/role 逐层),附建议 selector——看清稳定锚点,自己写 fold 规则')
  .argument('<n>', 'view 输出的 ref 序号(穿透 shadow)')
  .option('--ancestor <k>', '按 ref 定位后向上爬 K 层父级再列(默认 0)')
  .action(async (n, opts) => {
    const r = await api.info(await needTarget(opts.target), Number(n), opts.ancestor != null ? Number(opts.ancestor) : undefined);
    printInfoChain(r);
  });

targetCmd('article', '以 ref 为根提取格式友好的 Markdown 文章(保序、不截断;穿透 shadow;黑名单链接只留文本)')
  .argument('<n>', 'view 输出的 ref 序号(穿透 shadow)')
  .option('--ancestor <k>', '按 ref 定位后向上爬 K 层父级再提取(默认 0)')
  .action(async (n, opts) => {
    const r = await api.article(await needTarget(opts.target), Number(n), opts.ancestor != null ? Number(opts.ancestor) : undefined);
    if (r?.refInvalid) { printRefInvalid(r); return; }
    if (!r?.lines?.length) { console.log('(空文章)'); return; }
    console.log(r.lines.join('\n'));
  });


feedbackOpt(targetCmd('press-key', '按键/组合键,如 Enter、Ctrl+Shift+A、Tab')).argument('<key>', '按键')
  .action(async (key: string, opts: any) => { const r = await api.pressKey(await needTarget(opts.target), key, feedbackCfg(opts)); console.log(`已按键: ${key}`); printFeedback(r?.feedback); });

feedbackOpt(targetOpt(targetCmd('hover', '鼠标移到元素上'))).argument('<target>', 'ref 序号或 selector(全数字=ref)')
  .action(async (t: string, opts: any) => { const arg = normTarget(t, opts.ancestor); const r = await api.hover(await needTarget(opts.target), arg, feedbackCfg(opts)); printAction(`已悬停: ${argLabel(arg)}`, r); printFeedback(r?.feedback); });

targetCmd('screenshot', '截图').option('-f, --file <file>', '输出文件')
  .action(async (opts) => { const file = await api.screenshot(await needTarget(opts.target), opts.file); console.log(`已截图: ${file}`); });

targetCmd('logs', '读 target 控制台日志(常驻 daemon,支持过滤)')
  .option('--level <level>', '过滤级别,如 error,warn')
  .option('--since <ms>', '仅最近 N 毫秒,单位毫秒')
  .option('--json', 'JSON 输出')
  .action(async (opts) => {
    const t = await needTarget(opts.target); const entries = await api.logs(t, { level: opts.level, since: opts.since });
    if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    if (!entries.length) { console.log(`(无控制台日志 · ${t.title || t.url})`); return; }
    console.log(`→ ${t.title} ${t.url}`);
    for (const e of entries) { const ts = new Date(e.ts).toTimeString().slice(0, 8); const loc = (e.line != null) ? ` (${e.line}:${e.col ?? ''})` : ''; const argsText = (e.args || []).map((a: any) => a == null ? 'undefined' : (typeof a === 'string' ? a : JSON.stringify(a))).join(' '); console.log(`[${ts}][${e.level}] ${argsText}${loc}`); }
  });

if (require.main === module) {
  program.parseAsync(process.argv).catch((err: any) => {
    console.error(`错误: ${err.message}`);
    // 用 exitCode 而非 process.exit(1):强制退出会在 undici fetch 连接残留时触发 libuv 断言崩溃(Windows UV_HANDLE_CLOSING)。
    process.exitCode = 1;
  });
}

export = api;
