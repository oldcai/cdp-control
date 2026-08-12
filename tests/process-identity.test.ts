// process-identity.test.ts — 仅注入文本/命令，验证跨平台 birth identity，不读真实进程。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  darwinProcessStartTime,
  linuxProcessStartTicks,
  processBirthIdentity,
  type ProcessIdentityDependencies,
} from '../src/process-identity.ts';

interface ProcessIdentityCall {
  file: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
}

function fakeDependencies(options: { file?: string; output?: string }): ProcessIdentityDependencies & {
  calls: ProcessIdentityCall[];
} {
  const calls: ProcessIdentityCall[] = [];
  return {
    calls,
    readFile: path => {
      calls.push({ file: path, args: [] });
      return options.file ?? '';
    },
    run: (file, args, environment) => {
      const call: ProcessIdentityCall = { file, args };
      if (environment) call.environment = environment;
      calls.push(call);
      return options.output ?? '';
    },
  };
}

function darwinProcessInfo(pid: number, seconds = 1_786_567_616n, microseconds = 53_026n): string {
  const info = Buffer.alloc(136);
  info.writeUInt32LE(pid, 12);
  info.writeBigUInt64LE(seconds, 120);
  info.writeBigUInt64LE(microseconds, 128);
  return info.toString('base64');
}

test('processBirthIdentity: runtime runner 对外部命令设置有界同步执行', () => {
  const source = readFileSync(new URL('../src/process-identity.ts', import.meta.url), 'utf8');
  assert.match(source, /maxBuffer:\s*16 \* 1024/);
  assert.match(source, /timeout:\s*10_000/);
});

test('linuxProcessStartTicks: comm 含空格/右括号时仍读取第 22 字段', () => {
  const fieldsFromState = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '424242', '20'];
  assert.equal(linuxProcessStartTicks(`1971 (chrome helper) worker) ${fieldsFromState.join(' ')}`), '424242');
  assert.throws(() => linuxProcessStartTicks('1971 malformed'), /comm/);
});

test('processBirthIdentity: Linux 使用 /proc start ticks', () => {
  const fieldsFromState = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '515151'];
  const dependencies = fakeDependencies({ file: `1971 (chrome) ${fieldsFromState.join(' ')}` });
  assert.equal(processBirthIdentity(1971, 'linux', dependencies), 'linux:515151');
  assert.deepEqual(dependencies.calls, [{ file: '/proc/1971/stat', args: [] }]);
});

test('processBirthIdentity: Windows 使用同步 StartTime UTC ticks', () => {
  const dependencies = fakeDependencies({ output: '638906987654321000\r\n' });
  assert.equal(processBirthIdentity(1972, 'win32', dependencies), 'win32:638906987654321000');
  assert.equal(dependencies.calls[0]?.file, 'powershell.exe');
  assert.deepEqual(dependencies.calls[0]?.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(dependencies.calls[0]?.args[3] ?? '', /Get-Process -Id 1972/);
});

test('processBirthIdentity: macOS 使用 proc_pidinfo 的微秒级 start timeval', () => {
  const dependencies = fakeDependencies({ output: darwinProcessInfo(1973) });
  assert.equal(processBirthIdentity(1973, 'darwin', dependencies), 'darwin:1786567616:53026');
  assert.equal(dependencies.calls[0]?.file, '/usr/bin/osascript');
  assert.deepEqual(dependencies.calls[0]?.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.match(dependencies.calls[0]?.args[3] ?? '', /proc_pidinfo/);
  assert.match(dependencies.calls[0]?.args[3] ?? '', /base64EncodedString/);
  assert.equal(dependencies.calls[0]?.args[4], '1973');
  assert.deepEqual(dependencies.calls[0]?.environment, {});
});

test('darwinProcessStartTime: 同秒内以 microseconds 区分进程实例', () => {
  assert.equal(darwinProcessStartTime(darwinProcessInfo(1973, 1_786_567_616n, 1n), 1973), '1786567616:1');
  assert.equal(darwinProcessStartTime(darwinProcessInfo(1973, 1_786_567_616n, 999_999n), 1973), '1786567616:999999');
});

test('processBirthIdentity: macOS runtime 对当前进程连读稳定', { skip: process.platform !== 'darwin' }, () => {
  const first = processBirthIdentity(process.pid);
  const second = processBirthIdentity(process.pid);
  assert.equal(first, second);
  assert.match(first, /^darwin:[1-9]\d*:\d{1,6}$/);
});

test('processBirthIdentity: 缺失/非法创建时间一律 fail closed', () => {
  assert.throws(() => processBirthIdentity(0, 'linux', fakeDependencies({})), /非法 PID/);
  assert.throws(() => processBirthIdentity(1974, 'win32', fakeDependencies({ output: '' })), /合法创建时间/);
  assert.throws(() => processBirthIdentity(1975, 'darwin', fakeDependencies({ output: '  ' })), /合法进程信息/);
  assert.throws(() => darwinProcessStartTime('!!!!', 1975), /合法进程信息/);
  assert.throws(() => darwinProcessStartTime(Buffer.alloc(135).toString('base64'), 1975), /合法进程信息/);
  assert.throws(() => darwinProcessStartTime(darwinProcessInfo(1975), 1976), /合法进程信息/);
  assert.throws(() => darwinProcessStartTime(darwinProcessInfo(1975, 0n), 1975), /合法创建时间/);
  assert.throws(() => darwinProcessStartTime(darwinProcessInfo(1975, 1n, 1_000_000n), 1975), /合法创建时间/);
  assert.throws(
    () => processBirthIdentity(1975, 'freebsd', fakeDependencies({ output: 'second precision' })),
    /不支持/,
  );
});
