/** monitor daemon 的进程绑定退出；不依赖 HTTP destructive request。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLsofListeners, parseNetstatListeners } from './browser-port.ts';

export interface DaemonProcessDependencies {
  readPidFile(path: string): string;
  listenerPids(port: number): number[];
  commandLine(pid: number): string;
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
  return commandLine.includes(scriptPath) && /(?:^|[\s"'])__daemon(?:$|[\s"'])/.test(commandLine);
}

/**
 * 只对同时满足 PID file、目标 loopback listener 和本 CLI `__daemon` 命令行的唯一进程发信号。
 * 即使 health 之后端口换主，也不会对新服务发 `/shutdown`。
 */
export function retireVerifiedDaemonProcess(
  port: number,
  pidFile: string,
  scriptPath: string,
  dependencies: DaemonProcessDependencies,
): void {
  let rawPid: string;
  try {
    rawPid = dependencies.readPidFile(pidFile);
  } catch (cause) {
    throw new Error(`无法读取待退出 daemon PID: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  const pid = legacyPid(rawPid);
  if (pid === null) throw new Error('待退出 daemon PID 文件无效，拒绝退出未绑定进程');

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

export async function retireDaemonProcess(port: number, scriptPath: string, pidFile: string): Promise<void> {
  retireVerifiedDaemonProcess(port, pidFile, scriptPath, {
    commandLine,
    listenerPids,
    readPidFile: path => readFileSync(path, 'utf8'),
    terminate: pid => process.kill(pid, 'SIGTERM'),
  });
}
