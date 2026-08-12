/** process-identity.ts — 跨平台同步读取进程 birth identity，防止 PID 复用误杀。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface ProcessIdentityDependencies {
  readFile(path: string): string;
  run(file: string, args: string[]): string;
}

const runtimeDependencies: ProcessIdentityDependencies = {
  readFile: path => readFileSync(path, 'utf8'),
  run: (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true }),
};

/** `/proc/<pid>/stat` 的第 22 字段是进程 starttime；comm 可包含空格和右括号。 */
export function linuxProcessStartTicks(stat: string): string {
  const commandEnd = stat.lastIndexOf(') ');
  if (commandEnd < 0) throw new Error('Linux process stat 缺少 comm 结束标记');
  // `) ` 后从 field 3(state) 开始，因此 field 22(starttime) 是下标 19。
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) throw new Error('Linux process stat 缺少合法 starttime');
  return startTicks;
}

function requiredNumericIdentity(value: string, source: string): string {
  const identity = value.trim();
  if (!/^\d+$/.test(identity)) throw new Error(`${source} 未返回合法创建时间`);
  return identity;
}

function darwinStartTime(base64: string): string {
  let info: Buffer;
  try {
    info = Buffer.from(base64.trim(), 'base64');
  } catch {
    throw new Error('macOS proc_pidinfo 未返回合法进程信息');
  }
  // struct proc_bsdinfo 的 pbi_start_tvsec / pbi_start_tvusec 位于偏移 120/128。
  if (info.length !== 136) throw new Error('macOS proc_pidinfo 未返回合法进程信息');
  const seconds = info.readBigUInt64LE(120);
  const microseconds = info.readBigUInt64LE(128);
  if (seconds === 0n || microseconds >= 1_000_000n) throw new Error('macOS proc_pidinfo 未返回合法创建时间');
  return `${seconds}:${microseconds}`;
}

/**
 * 同步读取 birth identity，供 signal 前无 await 地复核：
 * Linux 使用内核 start ticks；Windows 使用 StartTime UTC ticks；macOS 使用 proc_pidinfo timeval。
 */
export function processBirthIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  dependencies: ProcessIdentityDependencies = runtimeDependencies,
): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`非法 PID: ${pid}`);

  if (platform === 'linux') {
    return `linux:${linuxProcessStartTicks(dependencies.readFile(`/proc/${pid}/stat`))}`;
  }

  if (platform === 'win32') {
    const script =
      `$process = Get-Process -Id ${pid} -ErrorAction Stop; ` +
      '[Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)';
    const ticks = requiredNumericIdentity(
      dependencies.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]),
      'Windows Get-Process',
    );
    return `win32:${ticks}`;
  }

  if (platform === 'darwin') {
    const script =
      'ObjC.import("Foundation");' +
      'ObjC.bindFunction("proc_pidinfo", ["int", ["int", "int", "uint64", "void *", "int"]]);' +
      'var data=$.NSMutableData.dataWithLength(136);' +
      `var size=$.proc_pidinfo(${pid}, 3, 0, data.mutableBytes, 136);` +
      'if(size!==136) throw new Error("proc_pidinfo returned "+size);' +
      'ObjC.unwrap(data.base64EncodedStringWithOptions(0));';
    return `darwin:${darwinStartTime(dependencies.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]))}`;
  }

  throw new Error(`${platform} 不支持可靠的进程创建时间读取`);
}
