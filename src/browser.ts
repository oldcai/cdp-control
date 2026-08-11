/**
 * browser.ts — 确保 CDP 浏览器就绪。
 * 语义:读 ~/.cdp-control/browser.json 拿到 exe/kind/args/port/userData;
 * 已就绪(该端口有响应)→ 直接用(就绪零开销,1 次 GET);未就绪 → 读配置拉起
 * (缺失自动发现生成 / 存在则用 / 损坏警告不兜底 / 用户可改)。
 * 依赖 transport + monitor + browser-discover + browser-config。不再依赖 api(无环)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
// 相对 import 带 .ts 后缀:Node 侧全部经 esbuild bundle(后缀只影响解析、不进产物),
// 却让 tests/ 能直接 import 单测(与 recipe-runner.ts 同一写法)。
import { getJson, setPort, HOST, PORT } from './transport.ts';
import { maybeSpawnDaemon } from './monitor.ts';
import { discoverCandidates, type BrowserKind } from './browser-discover.ts';
import { browserConfigPath, parseBrowserConfig, defaultArgs, DEFAULT_PORT, DEFAULT_USER_DATA, type BrowserConfig } from './browser-config.ts';
import { portFreeOn, findFreePort, endpointAlive, parseNetstatListeners, parseLsofListeners } from './port.ts';
import { probeReady, probeReadySoon, pickPort } from './browser-port.ts';

export interface EnsureResult { ready: boolean; started: boolean; browser?: string; userData?: string; }
/** coldStart 结果:自己拉起来的浏览器,或"并发进程已拉起、直接复用"。 */
type ColdResult = { kind: BrowserKind; exe: string; userData: string; port: number } | { reused: string };
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
  // tmp 名带 pid:并发冷启动的两个进程都可能走到端口回写,共享固定 tmp 名会互踩
  // (A 刚 write 完,B 把同名 tmp rename 走,A 的 rename ENOENT)。进程内调用是同步串行的,pid 足够唯一。
  const tmp = `${p}.tmp.${process.pid}`;
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
 * 拉起并等就绪;端口没就绪就换个空闲口再试一次,成功返回实际端口,失败返回 null。
 * 为什么要重试:portFree 是"能不能 bind"的探测,posix 上准;win 上若占用方用了 SO_REUSEADDR,
 * 我们可能 bind 得上却仍与其撞口(浏览器起不来)。重试一次把这种漏检也兜住,不留平台差异。
 */
async function launchReady(exe: string, args: string[], port: number, userData: string): Promise<number | null> {
  for (const p of [port, null]) {
    let target: number;
    if (p === null) {
      // 挑不出可绑端口(EACCES/受限区间/地址不属于本机、或真被占满)是**硬失败**,换个候选浏览器也没用:
      // 让 findFreePort 的真因抛出去,别被"启动超时 + 单例"的兜底提示盖掉。
      target = await findFreePort(port + 1, 50, HOST);
      console.error(`⚠ 端口 ${port} 上浏览器没能就绪,改用 ${target} 重试`);
    } else target = p;
    setPort(target);
    try { launch(exe, args, target, userData); await waitReady(); return target; }
    catch { killLast(); }
  }
  return null;
}

/**
 * 启动失败最常见的真因不是"没浏览器",而是**同一 user-data 已被另一个浏览器实例占用**:
 * Chrome/Edge 单例机制会让新进程把参数转交给旧实例后自己退出 —— 于是新端口上永远没人应答。
 * 提示里直接给出可执行的下一步,别让人以为浏览器没装。
 */
function busyProfileHint(what: string, userData: string, cfgPath: string): string {
  return `${what}。\n最常见原因:已有浏览器实例占着同一 user-data(${userData}),单例机制让新进程直接退出。`
    + `\n处理:先 cdp-control kill(或手动关掉那个浏览器窗口)再重试;或编辑 ${cfgPath} 换 userData/port。`;
}

/**
 * 冷启动:有配置则用(坏则抛,不兜底);无配置则 bootstrap 发现并写配置。
 * `busyProbed`=调用方已确认被外人占着(已等过一轮)的**那个端口**;本函数重读的配置端口若与它不同
 * (并发进程回写过),pickPort 会重新探,不复用旧结论。
 * 返回 `{reused}` 表示端口上的浏览器是并发进程刚拉起的,本进程什么都不用启。
 */
async function coldStart(busyProbed: number | null): Promise<ColdResult> {
  const p = browserConfigPath();

  if (existsSync(p)) {
    let cfg: BrowserConfig | null;
    try { cfg = loadConfigOrNull(); }
    catch (e: any) { throw new Error(`${(e as Error).message}\n浏览器启动配置损坏,不做兜底,请编辑 ${p}`); }
    if (!cfg) throw new Error(`浏览器启动配置损坏,不做兜底,请编辑 ${p}`);
    if (!existsSync(cfg.exe)) throw new Error(`browser.json 的 exe 不存在: ${cfg.exe}\n请编辑 ${p}`);
    mkdirSync(cfg.userData, { recursive: true });
    const pick = await pickPort(cfg.port, busyProbed);
    if ('reused' in pick) return pick;
    const want = pick.port;
    const port = await launchReady(cfg.exe, cfg.args, want, cfg.userData);
    if (port == null) throw new Error(busyProfileHint(`浏览器启动超时(${cfg.exe} 在端口 ${want} 未就绪)`, cfg.userData, p));
    // 端口漂了(被占/没就绪换口)就回写配置,下次直接对
    if (port !== cfg.port) { writeConfigAtomic(p, { ...cfg, port }); console.error(`已把端口 ${port} 写回 ${p}`); }
    maybeSpawnDaemon();
    return { kind: cfg.kind, exe: cfg.exe, userData: cfg.userData, port };
  }

  // 缺失 → bootstrap:逐个候选尝试,首个能拉起者写配置(userData 用默认值,port 取首个空闲)
  const pick = await pickPort(DEFAULT_PORT, busyProbed);
  if ('reused' in pick) return pick;
  const want = pick.port;
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
    ? busyProfileHint(`找到浏览器但都没能在端口 ${want} 就绪(试过: ${tried.join(', ')})`, userData, p)
    : `未找到可用浏览器。可手动创建 ${p} 指定 exe/args`);
}

/** 确保有 CDP 浏览器在跑:就绪零开销(1 GET);未就绪自动拉起。 */
export async function ensureBrowser(): Promise<EnsureResult> {
  // 先同步端口(有配置则读其 port,无则保持默认 9222),再探活
  const cfg = loadConfigOrNull();
  if (cfg?.userData) mkdirSync(cfg.userData, { recursive: true });
  let probe = await probeReady();
  // 端口上有人、但还没应答 /json/version:很可能是**另一个 cdp-control 进程刚把浏览器拉起来**。
  // 这时抢着换端口会踩 Chrome 单例:同一个 user-data 的新进程转交参数后直接退出,自己却在新端口上空等到超时。
  // 先给它一小段时间应答;真是无关进程占着的话(如用户自己的浏览器),这点等待只在冷启动付一次。
  // 记下"确认被外人占着、并等过一轮"的**那个端口**(不是布尔):coldStart 会重读配置,端口可能已被
  // 并发进程回写成别的,布尔值会张冠李戴地免掉新端口的探测。
  const probed = Number(PORT);
  let busyProbed: number | null = null;
  if (!probe.ready && !(await portFreeOn(probed, HOST))) { busyProbed = probed; probe = await probeReadySoon(); }
  if (probe.ready) return { ready: true, started: false, browser: probe.browser, userData: cfg?.userData };
  // 端口"刚才空、进 coldStart 前被并发进程绑上"的 TOCTOU 窗口由 pickPort 兜住(那个端口没被确认占用时它会再等一轮)
  const info = await coldStart(busyProbed);
  if ('reused' in info) return { ready: true, started: false, browser: info.reused, userData: cfg?.userData };
  const name = `${info.kind} ${info.exe}`;
  console.error(`已自动启动浏览器: ${name} (端口 ${info.port})`);
  return { ready: true, started: true, browser: name, userData: info.userData };
}

/**
 * 找出**在 `HOST:port` 上监听**的进程 pid(win 走 netstat,posix 走 lsof)。两道过滤缺一不可:
 * - 只认 LISTEN:`lsof -ti :port` 把"连到该端口的客户端"(本工具的 monitor daemon 就是)也列出来,
 *   取首个会杀错人、浏览器还活着 → kill 报"未完全生效"(2026-08 m2 实测)。
 * - 只认服务 `HOST` 的地址:同一个端口号在 IPv4/IPv6 上是两个独立监听、可能属于两个不相干的进程
 *   (m2 上就同时有 `127.0.0.1:9222` 与 `[::1]:9222` 两个 Chrome)。只杀我们这条连接对面的那个,
 *   否则 kill 会顺手打死用户自己的进程。
 */
function pidsOnPort(port: number): number[] {
  try {
    if (process.platform === 'win32') {
      return parseNetstatListeners(execFileSync('netstat', ['-ano'], { encoding: 'utf8' }), port, HOST);
    }
    return parseLsofListeners(execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpnt'], { encoding: 'utf8' }), port, HOST);
  } catch { return []; }
}

/** 强制结束浏览器进程:端口从 browser.json 读;无配置则 kill 不生效。返回是否已无监听。 */
export async function killBrowser(): Promise<KillResult> {
  const p = browserConfigPath();
  if (!existsSync(p)) return { ok: false, port: 9222, reason: 'noConfig' };
  let cfg: BrowserConfig;
  try { cfg = parseBrowserConfig(readFileSync(p, 'utf8')); }
  catch { return { ok: false, port: 9222, reason: 'broken' }; }
  const port = cfg.port;
  const pids = pidsOnPort(port);
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch {}
  }
  // 等端口真正释放(最多 ~3s),Edge 崩溃自启会重绑
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (!pidsOnPort(port).length) {
      if (pids.length) return { ok: true, port, reason: 'killed' };
      // 一个可归属的进程都没找到:问端点还有没有人应答(connect 探测,与客户端同语义)。
      // 不能用 bind 探测:CDP_HOST 非本机时 bind 一律 EADDRNOTAVAIL,会把活着的远程端点谎报成 noProcess。
      // 明确没人(每个地址都 ECONNREFUSED)才算 ok;有人应答或判断不了(远程/解析失败/超时)都如实报 stillUp。
      const alive = await endpointAlive(port, HOST);
      if (alive !== false) return { ok: false, port, reason: 'stillUp' };
      return { ok: true, port, reason: 'noProcess' };
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { ok: false, port, reason: pids.length ? 'stillUp' : 'noProcess' };
}
