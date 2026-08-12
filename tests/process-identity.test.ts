// process-identity.test.ts — 仅注入文本/命令，验证跨平台 birth identity，不读真实进程。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  linuxProcessStartTicks,
  processBirthIdentity,
  type ProcessIdentityDependencies,
} from '../src/process-identity.ts';

function fakeDependencies(options: { file?: string; output?: string }): ProcessIdentityDependencies & {
  calls: Array<{ file: string; args: string[] }>;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  return {
    calls,
    readFile: path => {
      calls.push({ file: path, args: [] });
      return options.file ?? '';
    },
    run: (file, args) => {
      calls.push({ file, args });
      return options.output ?? '';
    },
  };
}

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

test('processBirthIdentity: macOS 使用 proc_pidinfo 的微秒级启动时间', () => {
  const info = Buffer.alloc(136);
  info.writeBigUInt64LE(1_786_567_646n, 120);
  info.writeBigUInt64LE(603_475n, 128);
  const dependencies = fakeDependencies({ output: info.toString('base64') });
  assert.equal(processBirthIdentity(1973, 'darwin', dependencies), 'darwin:1786567646:603475');
  assert.equal(dependencies.calls[0]?.file, '/usr/bin/osascript');
  assert.deepEqual(dependencies.calls[0]?.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.match(dependencies.calls[0]?.args[3] ?? '', /proc_pidinfo\(1973, 3, 0/);
});

test('processBirthIdentity: 缺失/非法创建时间一律 fail closed', () => {
  assert.throws(() => processBirthIdentity(0, 'linux', fakeDependencies({})), /非法 PID/);
  assert.throws(() => processBirthIdentity(1974, 'win32', fakeDependencies({ output: '' })), /合法创建时间/);
  assert.throws(() => processBirthIdentity(1975, 'darwin', fakeDependencies({ output: '  ' })), /未返回合法进程信息/);
});
