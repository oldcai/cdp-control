/** process-identity.ts — 跨平台同步读取进程 birth identity，防止 PID 复用误杀。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface ProcessIdentityDependencies {
  readFile(path: string): string;
  run(file: string, args: string[], environment?: NodeJS.ProcessEnv): string;
}

const runtimeDependencies: ProcessIdentityDependencies = {
  readFile: path => readFileSync(path, 'utf8'),
  run: (file, args, environment) =>
    execFileSync(file, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024,
      timeout: 10_000,
      windowsHide: true,
      ...(environment ? { env: environment } : {}),
    }),
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

// JXA 只负责调用 Darwin 的 proc_pidinfo 并返回完整结构；Node 侧再验证大小、PID 和 start timeval。
const DARWIN_PROCESS_START_SCRIPT = `
ObjC.import('Foundation')
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long', 'pointer', 'int']])
function run(argv) {
  const data = $.NSMutableData.dataWithLength(136)
  const read = $.proc_pidinfo(Number(argv[0]), 3, 0, data.mutableBytes, 136)
  if (read !== 136) throw new Error('proc_pidinfo failed')
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0))
}
`;

/** 验证并提取 Darwin proc_bsdinfo 的微秒级进程启动 timeval。 */
export function darwinProcessStartTime(encoded: string, expectedPid: number): string {
  const base64 = encoded.trim();
  const info = Buffer.from(base64, 'base64');
  // Darwin sys/proc_info.h ABI:sizeof=136，pbi_pid@12，两个 uint64 start timeval 字段从 offset 120 开始。
  if (info.length !== 136 || info.toString('base64') !== base64 || info.readUInt32LE(12) !== expectedPid) {
    throw new Error('Darwin proc_pidinfo 未返回合法进程信息');
  }
  const seconds = info.readBigUInt64LE(120);
  const microseconds = info.readBigUInt64LE(128);
  if (seconds === 0n || microseconds > 999_999n) {
    throw new Error('Darwin proc_pidinfo 未返回合法创建时间');
  }
  return `${seconds}:${microseconds}`;
}

/**
 * 同步读取 birth identity，供 signal 前无 await 地复核：
 * Linux 使用内核 start ticks；Windows 使用 StartTime UTC ticks；Darwin 使用 proc_pidinfo 的 start timeval。
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
    const started = darwinProcessStartTime(
      // 绝对路径 + 空环境避免用户级脚本/动态库变量影响 signal 前的身份门禁。
      dependencies.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DARWIN_PROCESS_START_SCRIPT, String(pid)], {}),
      pid,
    );
    return `darwin:${started}`;
  }

  throw new Error(`不支持在 ${platform} 上读取可靠的进程创建身份`);
}
