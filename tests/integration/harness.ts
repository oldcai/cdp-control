import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultArgs, type BrowserConfig } from '../../src/browser-config.ts';
import { discoverCandidates, type BrowserKind, type Candidate } from '../../src/browser-discover.ts';
import { findFreePort } from '../../src/port.ts';
import { closeServer, startFixture, type FixtureServer } from './fixture.ts';

const PROTECTED_PORTS = new Set([9222, 9223]);
const COMMAND_TIMEOUT_MS = 20_000;

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export interface ResolvedBrowser {
  exe: string;
  kind: BrowserKind;
}

export interface BrowserDiscovery {
  available: ResolvedBrowser[];
  checked: string[];
}

export interface CommandResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function visibleOutput(output: string): string {
  const visible = output.replace(/\r?\n$/, '');
  return visible.length ? visible : '<empty>';
}

/** CI 日志统一带场景、退出状态与双流，语义断言失败时也能直接定位。 */
export function formatCommandTranscript(stage: string, result: CommandResult): string {
  return [
    `场景「${stage}」命令结果: code=${result.code} signal=${result.signal ?? 'none'}`,
    'stdout:',
    visibleOutput(result.stdout),
    'stderr:',
    visibleOutput(result.stderr),
  ].join('\n');
}

function formatSpawnError(stage: string, error: Error, stdout: string, stderr: string): string {
  return `${formatCommandTranscript(stage, { code: 1, signal: null, stdout, stderr })}`
    + `\nspawn error: ${error.message}`;
}

interface BrowserHandle {
  child: ChildProcess;
  pid: number | undefined;
  port: number;
  stderrTail: string;
  spawnError?: Error;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(name: string): string | null {
  const pathValue = process.env.PATH || '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

function resolveCandidate(candidate: Candidate): string | null {
  if (isAbsolute(candidate.exe)) return executable(candidate.exe) ? candidate.exe : null;
  if (candidate.exe.includes('/') || candidate.exe.includes('\\')) {
    const path = resolve(candidate.exe);
    return executable(path) ? path : null;
  }
  return resolveFromPath(candidate.exe);
}

/** 使用产品代码的候选顺序，只在测试侧把命令名解析成可 spawn 的绝对路径。 */
export function discoverInstalledBrowsers(): BrowserDiscovery {
  const candidates = discoverCandidates();
  const available: ResolvedBrowser[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const exe = resolveCandidate(candidate);
    if (!exe || seen.has(exe)) continue;
    seen.add(exe);
    available.push({ exe, kind: candidate.kind });
  }
  return { available, checked: candidates.map(candidate => candidate.exe) };
}

function processGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!childAlive(child)) return Promise.resolve(true);
  return new Promise(resolveClose => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off('close', onClose);
      resolveClose(closed);
    };
    const onClose = () => finish(true);
    child.once('close', onClose);
    // 监听器必须先安装；否则进程可能恰好在首次 childAlive() 与 once() 之间关闭并丢失事件。
    if (!childAlive(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(!childAlive(child)), timeoutMs);
  });
}

function terminateTreeSync(child: ChildProcess, force = true): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
  }
}

function jsonTargets(value: unknown): { url?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { url?: string } => typeof item === 'object' && item !== null);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class IntegrationHarness {
  readonly token = `t2-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  readonly browsers: ResolvedBrowser[];

  home = '';
  rulesDir = '';
  foldFile = '';
  ignoreLinksFile = '';
  userData = '';
  fixtureUrl = '';
  fixturePort = 0;
  cdpPort = 0;
  logsPort = 0;
  selectedBrowser: ResolvedBrowser | null = null;

  private fixture: FixtureServer | null = null;
  private browser: BrowserHandle | null = null;
  private cliEnv: NodeJS.ProcessEnv | null = null;
  private readonly activeCommands = new Set<ChildProcess>();
  private cleanupPromise: Promise<void> | null = null;
  private guardsInstalled = false;
  private signalInProgress = false;

  private readonly exitHandler = (): void => this.cleanupSync();
  private readonly sigintHandler = (): void => { void this.handleSignal('SIGINT'); };
  private readonly sigtermHandler = (): void => { void this.handleSignal('SIGTERM'); };

  constructor(browsers: ResolvedBrowser[]) {
    this.browsers = browsers;
  }

  private installCleanupGuards(): void {
    if (this.guardsInstalled) return;
    this.guardsInstalled = true;
    process.on('exit', this.exitHandler);
    process.once('SIGINT', this.sigintHandler);
    process.once('SIGTERM', this.sigtermHandler);
  }

  private removeCleanupGuards(): void {
    if (!this.guardsInstalled) return;
    this.guardsInstalled = false;
    process.off('exit', this.exitHandler);
    process.off('SIGINT', this.sigintHandler);
    process.off('SIGTERM', this.sigtermHandler);
  }

  private async handleSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
    if (this.signalInProgress) return;
    this.signalInProgress = true;
    console.error(`\n收到 ${signal}，正在清理本测试拥有的子进程与临时目录…`);
    try { await this.cleanup(); }
    finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
  }

  private browserArgs(): string[] {
    return [
      ...defaultArgs(process.platform),
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--noerrdialogs',
      '--password-store=basic',
      '--use-mock-keychain',
      '--enable-automation',
      '--remote-debugging-address=127.0.0.1',
    ];
  }

  private writeBrowserConfig(browser: ResolvedBrowser, port: number, args: string[]): void {
    const config: BrowserConfig = {
      exe: browser.exe,
      kind: browser.kind,
      args,
      port,
      userData: this.userData,
    };
    writeFileSync(join(this.home, 'browser.json'), JSON.stringify(config, null, 2) + '\n');
  }

  private spawnBrowser(browser: ResolvedBrowser, port: number, args: string[]): BrowserHandle {
    const child = spawn(browser.exe, [
      ...args,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.userData}`,
      this.fixtureUrl,
    ], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const handle: BrowserHandle = { child, pid: child.pid, port, stderrTail: '' };
    child.stderr?.on('data', (chunk: Buffer | string) => {
      handle.stderrTail = (handle.stderrTail + chunk.toString()).slice(-16_000);
    });
    child.once('error', error => { handle.spawnError = error; });
    return handle;
  }

  private async waitForOwnedEndpoint(handle: BrowserHandle, port: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    let lastError = '';
    let exitedAt = 0;
    while (Date.now() < deadline) {
      if (handle.spawnError) throw handle.spawnError;
      if (!childAlive(handle.child) && exitedAt === 0) exitedAt = Date.now();
      try {
        const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(800),
        });
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(800),
        });
        if (version.ok && targets.ok) {
          const list = jsonTargets(await targets.json());
          if (list.some(target => target.url === this.fixtureUrl)) return;
          lastError = '端点已就绪，但未出现本测试唯一 fixture URL';
        }
      } catch (error: unknown) {
        lastError = errorText(error);
      }
      // 允许 Linux launcher 短暂退出后把同一进程组内的浏览器拉起，但不在明确失败上等满 20s。
      if (exitedAt && Date.now() - exitedAt > 2_000) break;
      await delay(100);
    }
    throw new Error(`浏览器未能在端口 ${port} 就绪并打开 fixture: ${lastError || '超时'}`);
  }

  private async stopBrowserHandle(handle: BrowserHandle): Promise<void> {
    if (!handle.pid) {
      const closed = await waitChildClose(handle.child, 2_000);
      if (!closed) throw new Error('浏览器 spawn 失败后 ChildProcess 句柄仍未关闭');
      return;
    }
    if (process.platform === 'win32') {
      terminateTreeSync(handle.child, true);
      let closed = await waitChildClose(handle.child, 2_000);
      if (!closed) {
        terminateTreeSync(handle.child, true);
        closed = await waitChildClose(handle.child, 2_000);
      }
      if (!closed) throw new Error(`taskkill 后浏览器父进程 ${handle.pid} 仍未退出`);
      const deadline = Date.now() + 3_000;
      while (await this.ownedEndpointAlive(handle.port)) {
        if (Date.now() >= deadline) {
          terminateTreeSync(handle.child, true);
          throw new Error(`taskkill 后本测试浏览器仍在端口 ${handle.port} 服务唯一 fixture`);
        }
        await delay(100);
      }
      return;
    }
    terminateTreeSync(handle.child, false);
    const deadline = Date.now() + 2_000;
    while (processGroupAlive(handle.pid) && Date.now() < deadline) await delay(50);
    if (processGroupAlive(handle.pid)) terminateTreeSync(handle.child, true);
    const killDeadline = Date.now() + 2_000;
    while (processGroupAlive(handle.pid) && Date.now() < killDeadline) await delay(50);
    if (processGroupAlive(handle.pid)) throw new Error(`无法终止本测试拥有的浏览器进程组 ${handle.pid}`);
    const endpointDeadline = Date.now() + 3_000;
    while (await this.ownedEndpointAlive(handle.port)) {
      if (Date.now() >= endpointDeadline) {
        throw new Error(`进程组终止后本测试 fixture 仍在端口 ${handle.port} 存活，可能有逃离进程组的 launcher`);
      }
      await delay(100);
    }
  }

  private async ownedEndpointAlive(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) return false;
      return jsonTargets(await response.json()).some(target => target.url === this.fixtureUrl);
    } catch {
      return false;
    }
  }

  private async stopActiveCommands(): Promise<void> {
    const children = [...this.activeCommands];
    if (!children.length) return;
    for (const child of children) {
      try {
        if (process.platform === 'win32') terminateTreeSync(child, true);
        else child.kill('SIGTERM');
      } catch {}
    }
    await Promise.all(children.map(child => waitChildClose(child, 1_000)));
    for (const child of children.filter(childAlive)) {
      try {
        if (process.platform === 'win32') terminateTreeSync(child, true);
        else child.kill('SIGKILL');
      } catch {}
    }
    const closed = await Promise.all(children.map(child => waitChildClose(child, 2_000)));
    const survivors = children.filter((_child, index) => !closed[index]);
    if (survivors.length) throw new Error(`无法终止 ${survivors.length} 个本测试 CLI 子进程`);
    for (const child of children) this.activeCommands.delete(child);
  }

  private async stopBrowser(): Promise<void> {
    const handle = this.browser;
    if (!handle) return;
    try {
      await this.stopBrowserHandle(handle);
      this.browser = null;
    } catch (error: unknown) {
      this.browser = handle; // 保留句柄，让 exit 同步兜底还能重试精确终止该进程组。
      throw error;
    }
  }

  private isolatedEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      'CDP_HOME',
      'CDP_HOST',
      'CDP_PORT',
      'CDP_NO_AUTOSTART',
      'CDP_LOGS_PORT',
      'CDP_RULES_DIR',
      'CDP_RULES_DEFAULT_DIR',
      'CDP_FOLD_FILE',
      'CDP_IGNORE_LINKS_FILE',
    ]) delete environment[key];
    environment.CDP_HOME = this.home;
    environment.CDP_HOST = '127.0.0.1';
    environment.CDP_PORT = String(this.cdpPort);
    environment.CDP_NO_AUTOSTART = '1';
    environment.CDP_LOGS_PORT = String(this.logsPort);
    return environment;
  }

  async start(): Promise<void> {
    mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true });
    this.home = mkdtempSync(join(REPO_ROOT, 'tmp', 'cdp-integration-'));
    this.installCleanupGuards();
    this.rulesDir = join(this.home, 'rules');
    this.foldFile = join(this.rulesDir, 'fold.csv');
    this.ignoreLinksFile = join(this.rulesDir, 'ignore-links.csv');
    this.userData = join(this.home, 'user-data');
    mkdirSync(this.rulesDir, { recursive: true });
    mkdirSync(this.userData, { recursive: true });
    writeFileSync(this.foldFile, '');
    writeFileSync(this.ignoreLinksFile, '');

    this.fixture = await startFixture(this.token);
    this.fixtureUrl = this.fixture.url;
    this.fixturePort = this.fixture.port;

    const failures: string[] = [];
    const basePort = 40_000 + (process.pid % 10_000);
    const args = this.browserArgs();
    for (let index = 0; index < this.browsers.length; index++) {
      const browser = this.browsers[index];
      const port = await findFreePort(basePort + index * 64, 64, '127.0.0.1');
      if (PROTECTED_PORTS.has(port)) throw new Error(`安全检查失败：禁止使用端口 ${port}`);
      await rm(this.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      mkdirSync(this.userData, { recursive: true });
      this.writeBrowserConfig(browser, port, args);
      let handle: BrowserHandle | null = null;
      try {
        handle = this.spawnBrowser(browser, port, args);
        this.browser = handle;
        await this.waitForOwnedEndpoint(handle, port);
        this.cdpPort = port;
        this.selectedBrowser = browser;
        break;
      } catch (error: unknown) {
        const exit = handle
          ? `pid=${handle.pid ?? 'none'} exitCode=${handle.child.exitCode ?? 'none'} signal=${handle.child.signalCode ?? 'none'}`
          : 'pid=none exitCode=spawn-threw signal=none';
        const tail = handle?.stderrTail.trim() || '<empty>';
        failures.push(`候选 ${browser.kind} ${browser.exe}\n${exit}\n原因: ${errorText(error)}\nstderr 尾部:\n${tail}`);
        try { await this.stopBrowser(); }
        catch (cleanupError: unknown) {
          failures.push(`${browser.exe} 清理失败: ${errorText(cleanupError)}`);
          break;
        }
      }
    }
    if (!this.browser || !this.selectedBrowser) {
      throw new Error(`发现了浏览器可执行文件，但无一能启动（不能假装 SKIP）。`
        + `\n试过的候选:\n${failures.join('\n---\n')}`);
    }

    this.logsPort = await findFreePort(55_000 + (process.pid % 5_000), 100, '127.0.0.1');
    if (PROTECTED_PORTS.has(this.logsPort)) throw new Error(`安全检查失败：禁止使用端口 ${this.logsPort}`);
    this.cliEnv = this.isolatedEnvironment();
    console.log(`INTEGRATION: browser=${this.selectedBrowser.kind} ${this.selectedBrowser.exe}`);
    console.log(`INTEGRATION: CDP_HOME=${this.home} CDP_PORT=${this.cdpPort} fixture=${this.fixtureUrl}`);
  }

  browserConfig(): BrowserConfig {
    return JSON.parse(readFileSync(join(this.home, 'browser.json'), 'utf8')) as BrowserConfig;
  }

  writeFoldRule(text: string): void {
    writeFileSync(this.foldFile, text);
  }

  writeTempScript(name: string, source: string): string {
    const path = join(this.home, name);
    writeFileSync(path, source);
    return path;
  }

  async waitForFixturePage(targetMatch: string = this.token): Promise<void> {
    const deadline = Date.now() + 15_000;
    let last = '';
    while (Date.now() < deadline) {
      const result = await this.runCli([
        'eval',
        '--target', targetMatch,
        `document.readyState === 'complete' && window.fixtureReady === true`,
      ], '等待 fixture DOM 就绪', 5_000);
      last = `${result.stderr}\n${result.stdout}`.trim();
      if (result.code === 0 && result.stdout.trim() === 'true') return;
      await delay(100);
    }
    throw new Error(`等待 fixture DOM 就绪超时。最后输出:\n${last}`);
  }

  runCli(args: string[], stage: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
    if (!this.cliEnv) return Promise.reject(new Error('集成 harness 尚未启动'));
    const child = spawn(process.execPath, [join(REPO_ROOT, 'dist', 'cdp.js'), ...args], {
      cwd: REPO_ROOT,
      env: this.cliEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.activeCommands.add(child);
    return new Promise((resolveCommand, rejectCommand) => {
      let stdout = '';
      let stderr = '';
      let spawnError: Error | null = null;
      let timedOut = false;
      child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
      child.once('error', error => { spawnError = error; });
      const timer = setTimeout(() => {
        timedOut = true;
        terminateTreeSync(child, true);
      }, timeoutMs);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        this.activeCommands.delete(child);
        if (spawnError) {
          rejectCommand(new Error(formatSpawnError(stage, spawnError, stdout, stderr)));
          return;
        }
        if (timedOut) {
          rejectCommand(new Error(`场景「${stage}」超时(${timeoutMs}ms)\nstdout:\n${stdout}\nstderr:\n${stderr}`));
          return;
        }
        if (stderr.includes('已自动启动浏览器')) {
          rejectCommand(new Error(`场景「${stage}」检测到 dist 自启动了未跟踪浏览器，终止以防漏进程:\n`
            + formatCommandTranscript(stage, { code: code ?? 1, signal, stdout, stderr })));
          return;
        }
        const result = { code: code ?? 1, signal, stdout, stderr };
        if (process.env.CDP_INTEGRATION_DIAGNOSTICS === '1') {
          console.log(formatCommandTranscript(stage, result));
        }
        resolveCommand(result);
      });
    });
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.cleanupInner();
    return this.cleanupPromise;
  }

  private async cleanupInner(): Promise<void> {
    const errors: string[] = [];
    try { await this.stopActiveCommands(); } catch (error: unknown) { errors.push(errorText(error)); }
    try { await this.stopBrowser(); } catch (error: unknown) { errors.push(errorText(error)); }
    if (this.fixture) {
      try { await closeServer(this.fixture.server); } catch (error: unknown) { errors.push(errorText(error)); }
      this.fixture = null;
    }
    const removed = this.home;
    if (removed) {
      try {
        await rm(removed, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      } catch (error: unknown) {
        errors.push(`删除临时目录失败 ${removed}: ${errorText(error)}`);
      }
      if (existsSync(removed)) errors.push(`临时目录仍存在: ${removed}`);
      else console.log(`CLEANED: ${removed}`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    this.removeCleanupGuards();
  }

  private cleanupSync(): void {
    for (const child of this.activeCommands) terminateTreeSync(child, true);
    if (this.browser) terminateTreeSync(this.browser.child, true);
    if (this.home) {
      try { rmSync(this.home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
    }
  }
}
