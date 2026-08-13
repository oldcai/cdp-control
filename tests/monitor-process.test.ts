// monitor-process.test.ts — legacy daemon 必须绑定到已验证 PID，不操作真进程。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type DaemonProcessAuthority,
  legacyDaemonPidFilePath,
  type DaemonProcessDependencies,
  retireVerifiedDaemonProcess,
} from '../src/monitor-process.ts';

type BirthRead = string | Error;

function fakeDependencies(options: {
  pidFile?: string;
  listeners?: number[];
  command?: string;
  births?: BirthRead[];
}): DaemonProcessDependencies & { birthPids: number[]; terminated: number[] } {
  const birthPids: number[] = [];
  const births = options.births ?? ['linux:12345', 'linux:12345'];
  const terminated: number[] = [];
  return {
    commandLine: () => options.command ?? '/usr/bin/node /repo/dist/cdp.js __daemon',
    listenerPids: () => options.listeners ?? [4312],
    processBirth: pid => {
      birthPids.push(pid);
      const birth = births[birthPids.length - 1] ?? births.at(-1);
      if (birth instanceof Error) throw birth;
      if (birth === undefined) throw new Error('fixture 缺少 birth identity');
      return birth;
    },
    readPidFile: () => options.pidFile ?? '4312\n',
    terminate: pid => terminated.push(pid),
    birthPids,
    terminated,
  };
}

test('legacyDaemonPidFilePath: 旧版全局 pid file 只从显式 tmp root 派生', () => {
  assert.equal(legacyDaemonPidFilePath(join('tmp', 'fixture')), join('tmp', 'fixture', 'cdp-listen.pid'));
});

test('retireVerifiedDaemonProcess: legacy PID/listener/command/birth 双读一致才发信号', () => {
  const dependencies = fakeDependencies({});
  retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo/dist/cdp.js', dependencies);
  assert.deepEqual(dependencies.terminated, [4312]);
  assert.deepEqual(dependencies.birthPids, [4312, 4312]);
});

test('retireVerifiedDaemonProcess: v1 expected instance 与全部进程证据一致才发信号', () => {
  const expected: DaemonProcessAuthority = { pid: 4312, birth: 'linux:12345' };
  const dependencies = fakeDependencies({});
  retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo/dist/cdp.js', dependencies, expected);
  assert.deepEqual(dependencies.terminated, [4312]);
  assert.deepEqual(dependencies.birthPids, [4312, 4312]);
});

test('retireVerifiedDaemonProcess: stale PID、多 listener 或 foreign 命令行均 fail closed', () => {
  const cases = [
    fakeDependencies({ pidFile: 'not-a-pid' }),
    fakeDependencies({ listeners: [9999] }),
    fakeDependencies({ listeners: [4312, 9999] }),
    fakeDependencies({ command: '/usr/bin/node /repo/dist/cdp.js worker' }),
    fakeDependencies({ command: '/usr/bin/node /other/dist/cdp.js __daemon' }),
    fakeDependencies({ command: '/usr/bin/node /repo/dist/cdp.js.backup __daemon' }),
    fakeDependencies({ command: '/usr/bin/node /tmp/repo/dist/cdp.js __daemon' }),
    fakeDependencies({ command: '/usr/bin/node /repo/dist/cdp.js __daemon --lookalike' }),
  ];
  for (const dependencies of cases) {
    assert.throws(
      () => retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo/dist/cdp.js', dependencies),
      /PID|listener|daemon/i,
    );
    assert.deepEqual(dependencies.terminated, []);
  }
});

test('retireVerifiedDaemonProcess: 引号中的精确 script argv token 可通过门禁', () => {
  const dependencies = fakeDependencies({ command: '/usr/bin/node "/repo with spaces/dist/cdp.js" __daemon' });
  retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo with spaces/dist/cdp.js', dependencies);
  assert.deepEqual(dependencies.terminated, [4312]);
});

test('retireVerifiedDaemonProcess: ps 丢失 argv 引号时仍精确识别含空格的末尾 invocation', () => {
  const dependencies = fakeDependencies({ command: '/usr/bin/node /repo with spaces/dist/cdp.js __daemon' });
  retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo with spaces/dist/cdp.js', dependencies);
  assert.deepEqual(dependencies.terminated, [4312]);
});

test('retireVerifiedDaemonProcess: legacy initial/final birth identity 变化时 fail closed', () => {
  const dependencies = fakeDependencies({ births: ['linux:12345', 'linux:99999'] });
  assert.throws(
    () => retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo/dist/cdp.js', dependencies),
    /birth|进程实例/i,
  );
  assert.deepEqual(dependencies.terminated, []);
});

test('retireVerifiedDaemonProcess: v1 expected PID 或 initial/final birth 不一致时 fail closed', () => {
  const cases: Array<{ dependencies: ReturnType<typeof fakeDependencies>; expected: DaemonProcessAuthority }> = [
    {
      dependencies: fakeDependencies({}),
      expected: { pid: 9999, birth: 'linux:12345' },
    },
    {
      dependencies: fakeDependencies({ births: ['linux:22222', 'linux:22222'] }),
      expected: { pid: 4312, birth: 'linux:12345' },
    },
    {
      dependencies: fakeDependencies({ births: ['linux:12345', 'linux:22222'] }),
      expected: { pid: 4312, birth: 'linux:12345' },
    },
  ];

  for (const { dependencies, expected } of cases) {
    assert.throws(
      () => retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo/dist/cdp.js', dependencies, expected),
      /PID|birth|进程实例/i,
    );
    assert.deepEqual(dependencies.terminated, []);
  }
});

test('retireVerifiedDaemonProcess: initial/final birth identity 读取失败均 fail closed', () => {
  const cases = [
    fakeDependencies({ births: [new Error('initial birth fixture')] }),
    fakeDependencies({ births: ['linux:12345', new Error('final birth fixture')] }),
  ];

  for (const dependencies of cases) {
    assert.throws(
      () => retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo/dist/cdp.js', dependencies),
      /birth|进程实例/i,
    );
    assert.deepEqual(dependencies.terminated, []);
  }
});
