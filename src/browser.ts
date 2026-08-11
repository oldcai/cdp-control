/**
 * browser.ts — 确保 CDP 浏览器就绪。
 * 语义:读 ~/.cdp-control/browser.json 拿到 exe/kind/args/port/userData;
 * 已就绪(该端口有响应)→ 直接用(就绪零开销,1 次 GET);未就绪 → 读配置拉起
 * (缺失自动发现生成 / 存在则用 / 损坏警告不兜底 / 用户可改)。
 * 依赖 transport + monitor + browser-discover + browser-config。不再依赖 api(无环)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { getJson, setPort } from './transport';
import { maybeSpawnDaemon } from './monitor';
import { discoverCandidates, type BrowserKind } from './browser-discover';
import { browserConfigPath, parseBrowserConfig, defaultArgs, DEFAULT_PORT, DEFAULT_USER_DATA, type BrowserConfig } from './browser-config';
import { portFree, findFreePort } from './port';

export interface EnsureResult { ready: boolean; started: boolean; browser?: string; userData?: string; }
export interface KillResult { ok: boolean; port: number; reason: 'killed' | 'noProcess' | 'stillUp' | 'noConfig' | 'broken'; }

let child: ReturnType<typeof spawn> | null = null;

/** 杀掉上次 bootstrap 尝试的进程(仅多候选降级时用)。 */
function killLast(): void {
  if (!child) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {}
  child = null;
}

function launch(exe: string, args: string[], port: number, userData: string): void {
  killLast();
  child = spawn(exe, [...args, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function waitReady(timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await getJson('/json/version'); if (v?.webSocketDebuggerUrl) return; } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('浏览器启动超时');
}

/** ready 探活(一次 GET,顺带拿浏览器名)。 */
async function probeReady(): Promise<{ ready: boolean; browser?: string }> {
  try {
    const v = await getJson('/json/version');
    if (!v?.webSocketDebuggerUrl) return { ready: false };
    return { ready: true, browser: describeBrowser(v.Browser || '') };
  } catch { return { ready: false }; }
}

function describeBrowser(s: string): string {
  if (/Edg\//i.test(s)) return `Microsoft Edge (${s})`;
  if (/Chrome\//i.test(s)) return `Google Chrome (${s})`;
  return s || '未知浏览器';
}

/** linux 候选名 → 绝对路径;win/mac 已绝对路径,existsSync 过滤。返回 null 表示不可用。 */
function resolveExe(exe: string): string | null {
  if (process.platform === 'linux' && !exe.includes('/')) {
    const r = spawnSync('sh', ['-c', `command -v ${exe}`], { encoding: 'utf8' });
    const p = (r.stdout || '').trim();
    return p || null;
  }
  return existsSync(exe) ? exe : null;
}

function writeConfigAtomic(p: string, cfg: BrowserConfig): void {
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, p);
}

/** 读配置并同步 transport 端口。无配置返回 null(交由调用方 bootstrap)。 */
function loadConfigOrNull(): BrowserConfig | null {
  const p = browserConfigPath();
  if (!existsSync(p)) return null;
  const cfg = parseBrowserConfig(readFileSync(p, 'utf8'));
  setPort(cfg.port);
  return cfg;
}

/**
 * 定端口:want 空闲就用它;被别的进程占着(走到 coldStart 说明它不是可用 CDP 端点,
 * 否则 probeReady 早命中了)则换下一个空闲端口 —— 不换的话 Chrome 会静默绑到 [::1],
 * 客户端连 127.0.0.1 永远超时。只定端口不写配置(配置由调用方在真起来之后写)。
 */
async function pickPort(want: number): Promise<number> {
  if (await portFree(want)) { setPort(want); return want; }
  const port = await findFreePort(want + 1);
  setPort(port);
  console.error(`⚠ 端口 ${want} 被其它进程占用(且不是可用的 CDP 端点),改用 ${port}`);
  return port;
}

/**
 * 拉起并等就绪;端口没就绪就换个空闲口再试一次,成功返回实际端口,失败返回 null。
 * 为什么要重试:portFree 是"能不能 bind"的探测,posix 上准;win 上若占用方用了 SO_REUSEADDR,
 * 我们可能 bind 得上却仍与其撞口(浏览器起不来)。重试一次把这种漏检也兜住,不留平台差异。
 */
async function launchReady(exe: string, args: string[], port: number, userData: string): Promise<number | null> {
  for (const p of [port, null]) {
    let target: number;
    if (p === null) {
      try { target = await findFreePort(port + 1); } catch { return null; }
      console.error(`⚠ 端口 ${port} 上浏览器没能就绪,改用 ${target} 重试`);
    } else target = p;
    setPort(target);
    try { launch(exe, args, target, userData); await waitReady(); return target; }
    catch { killLast(); }
  }
  return null;
}

/** 冷启动:有配置则用(坏则抛,不兜底);无配置则 bootstrap 发现并写配置。 */
async function coldStart(): Promise<{ kind: BrowserKind; exe: string; userData: string; port: number }> {
  const p = browserConfigPath();

  if (existsSync(p)) {
    let cfg: BrowserConfig | null;
    try { cfg = loadConfigOrNull(); }
    catch (e: any) { throw new Error(`${(e as Error).message}\n浏览器启动配置损坏,不做兜底,请编辑 ${p}`); }
    if (!cfg) throw new Error(`浏览器启动配置损坏,不做兜底,请编辑 ${p}`);
    if (!existsSync(cfg.exe)) throw new Error(`browser.json 的 exe 不存在: ${cfg.exe}\n请编辑 ${p}`);
    mkdirSync(cfg.userData, { recursive: true });
    const want = await pickPort(cfg.port);
    const port = await launchReady(cfg.exe, cfg.args, want, cfg.userData);
    if (port == null) throw new Error(`浏览器启动超时(${cfg.exe} 在端口 ${want} 未就绪)。请检查 ${p} 的 exe/args/port`);
    // 端口漂了(被占/没就绪换口)就回写配置,下次直接对
    if (port !== cfg.port) { writeConfigAtomic(p, { ...cfg, port }); console.error(`已把端口 ${port} 写回 ${p}`); }
    maybeSpawnDaemon();
    return { kind: cfg.kind, exe: cfg.exe, userData: cfg.userData, port };
  }

  // 缺失 → bootstrap:逐个候选尝试,首个能拉起者写配置(userData 用默认值,port 取首个空闲)
  const want = await pickPort(DEFAULT_PORT);
  const userData = DEFAULT_USER_DATA();
  mkdirSync(userData, { recursive: true });
  const tried: string[] = [];
  for (const c of discoverCandidates()) {
    const exe = resolveExe(c.exe);
    if (!exe) continue;
    tried.push(exe);
    const args = defaultArgs();
    const port = await launchReady(exe, args, want, userData);
    if (port == null) continue;
    writeConfigAtomic(p, { exe, kind: c.kind, args, port, userData });
    maybeSpawnDaemon();
    return { kind: c.kind, exe, userData, port };
  }
  // 区分两种失败:一个候选都不存在 vs 存在但都没在端口上就绪(后者给出试过谁,别让人以为没装浏览器)
  throw new Error(tried.length
    ? `找到浏览器但都没能在端口 ${want} 就绪(试过: ${tried.join(', ')})。可手动创建 ${p} 指定 exe/args/port`
    : `未找到可用浏览器。可手动创建 ${p} 指定 exe/args`);
}

/** 确保有 CDP 浏览器在跑:就绪零开销(1 GET);未就绪自动拉起。 */
export async function ensureBrowser(): Promise<EnsureResult> {
  // 先同步端口(有配置则读其 port,无则保持默认 9222),再探活
  const cfg = loadConfigOrNull();
  if (cfg?.userData) mkdirSync(cfg.userData, { recursive: true });
  const probe = await probeReady();
  if (probe.ready) return { ready: true, started: false, browser: probe.browser, userData: cfg?.userData };
  const info = await coldStart();
  const name = `${info.kind} ${info.exe}`;
  console.error(`已自动启动浏览器: ${name} (端口 ${info.port})`);
  return { ready: true, started: true, browser: name, userData: info.userData };
}

/** 找出监听 port 的进程 pid(win 走 netstat,posix 走 lsof);无则 null。 */
function pidOnPort(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const pid = Number(line.trim().split(/\s+/).pop());
          if (pid) return pid;
        }
      }
    } else {
      const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).trim();
      if (out) return Number(out.split('\n')[0]);
    }
  } catch {}
  return null;
}

/** 强制结束浏览器进程:端口从 browser.json 读;无配置则 kill 不生效。返回是否已无监听。 */
export async function killBrowser(): Promise<KillResult> {
  const p = browserConfigPath();
  if (!existsSync(p)) return { ok: false, port: 9222, reason: 'noConfig' };
  let cfg: BrowserConfig;
  try { cfg = parseBrowserConfig(readFileSync(p, 'utf8')); }
  catch { return { ok: false, port: 9222, reason: 'broken' }; }
  const port = cfg.port;
  const pid = pidOnPort(port);
  if (pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch {}
  }
  // 等端口真正释放(最多 ~3s),Edge 崩溃自启会重绑
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (pidOnPort(port) === null) return { ok: true, port, reason: pid ? 'killed' : 'noProcess' };
    await new Promise(r => setTimeout(r, 300));
  }
  return { ok: false, port, reason: pid ? 'stillUp' : 'noProcess' };
}
