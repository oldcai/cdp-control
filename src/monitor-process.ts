/** monitor daemon 的进程绑定退出；不依赖 HTTP destructive request。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLsofListeners, parseNetstatListeners } from './browser-port.ts';
import { processBirthIdentity } from './process-identity.ts';

/** health 与退出门禁共同引用的具体 daemon 进程实例。 */
export interface DaemonProcessAuthority {
  pid: number;
  birth: string;
}

export interface DaemonProcessDependencies {
  readPidFile(path: string): string;
  listenerPids(port: number): number[];
  commandLine(pid: number): string;
  /** 必须同步返回，确保最终 birth 复核到 signal 之间没有 await。 */
  processBirth(pid: number): string;
  terminate(pid: number): void;
}

export function legacyDaemonPidFilePath(tempRoot: string = tmpdir()): string {
  return join(tempRoot, 'cdp-listen.pid');
}

function legacyPid(raw: string): number | null {
  if (!/^\d+\s*$/.test(raw)) return null;
  const pid = Number(raw.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isLegacyDaemonCommand(commandLine: string, scriptPath: string): boolean {
  // `ps command=` 在路径含空格时不会保留 argv 引号，不能安全地重新 tokenize。
  // 当前启动入口固定为 `[scriptPath, '__daemon']`，因此验证带 token 左边界的完整末尾；
  // 同时接受 Windows/CIM 或 fixture 可能保留的成对引号。
  const suffixes = [`${scriptPath} __daemon`, `"${scriptPath}" __daemon`, `'${scriptPath}' __daemon`];
  return suffixes.some(suffix => {
    const start = commandLine.length - suffix.length;
    return start >= 0 && commandLine.endsWith(suffix) && (start === 0 || /\s/.test(commandLine[start - 1]));
  });
}

function birthIdentity(pid: number, dependencies: DaemonProcessDependencies): string {
  try {
    const birth = dependencies.processBirth(pid);
    if (!birth.trim()) throw new Error('进程 birth identity 为空');
    return birth;
  } catch (cause) {
    throw new Error(`无法验证待退出 daemon 进程实例 birth: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

function assertExpectedAuthority(expected: DaemonProcessAuthority): void {
  if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0 || !expected.birth.trim()) {
    throw new Error('待退出 daemon expected instance 无效，拒绝发信号');
  }
}

/**
 * 只对同时满足 expected instance（若有）、PID file、唯一 loopback listener、本 CLI `__daemon`
 * 命令行和 birth 双读的具体进程实例发信号。即使 health 之后端口换主，也不会操作新服务。
 */
export function retireVerifiedDaemonProcess(
  port: number,
  pidFile: string,
  scriptPath: string,
  dependencies: DaemonProcessDependencies,
  expected?: DaemonProcessAuthority,
): void {
  let rawPid: string;
  try {
    rawPid = dependencies.readPidFile(pidFile);
  } catch (cause) {
    throw new Error(`无法读取待退出 daemon PID: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  const pid = legacyPid(rawPid);
  if (pid === null) throw new Error('待退出 daemon PID 文件无效，拒绝退出未绑定进程');
  if (expected) {
    assertExpectedAuthority(expected);
    if (pid !== expected.pid) {
      throw new Error(`待退出 daemon PID ${pid} 与 health instance PID ${expected.pid} 不一致，拒绝发信号`);
    }
  }

  const initialBirth = birthIdentity(pid, dependencies);
  if (expected && initialBirth !== expected.birth) {
    throw new Error(`PID ${pid} 的 birth 与 health instance 不一致，拒绝发信号`);
  }

  let listeners: number[];
  try {
    listeners = [...new Set(dependencies.listenerPids(port))].filter(
      candidate => Number.isInteger(candidate) && candidate > 0,
    );
  } catch (cause) {
    throw new Error(`无法验证待退出 daemon listener: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
  if (listeners.length !== 1 || listeners[0] !== pid) {
    throw new Error(`待退出 daemon PID ${pid} 与端口 ${port} listener 不唯一一致，拒绝发信号`);
  }

  let commandLine: string;
  try {
    commandLine = dependencies.commandLine(pid);
  } catch (cause) {
    throw new Error(`无法验证待退出 daemon 命令行: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
  if (!isLegacyDaemonCommand(commandLine, scriptPath)) {
    throw new Error(`PID ${pid} 不是当前 cdp-control 的 daemon，拒绝发信号`);
  }

  // legacy/v0 以 initial birth 为 authority；v1 则始终以 health 发布的 instance 为 authority。
  // 这是 signal 前最后一个同步检查；其后不得插入 await 或其它异步边界。
  const finalBirth = birthIdentity(pid, dependencies);
  const authoritativeBirth = expected?.birth ?? initialBirth;
  if (finalBirth !== authoritativeBirth) {
    throw new Error(`PID ${pid} 的进程实例 birth 已变化，拒绝结束替代进程`);
  }
  dependencies.terminate(pid);
}

function listenerPids(port: number): number[] {
  if (process.platform === 'win32') {
    return parseNetstatListeners(execFileSync('netstat', ['-ano'], { encoding: 'utf8' }), port, '127.0.0.1');
  }
  return parseLsofListeners(
    execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpnt'], { encoding: 'utf8' }),
    port,
    '127.0.0.1',
  );
}

function commandLine(pid: number): string {
  if (process.platform === 'win32') {
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ],
      { encoding: 'utf8' },
    ).trim();
  }
  return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
}

export async function retireDaemonProcess(
  port: number,
  scriptPath: string,
  pidFile: string,
  expected?: DaemonProcessAuthority,
): Promise<void> {
  retireVerifiedDaemonProcess(
    port,
    pidFile,
    scriptPath,
    {
      commandLine,
      listenerPids,
      processBirth: processBirthIdentity,
      readPidFile: path => readFileSync(path, 'utf8'),
      terminate: pid => process.kill(pid, 'SIGTERM'),
    },
    expected,
  );
}
