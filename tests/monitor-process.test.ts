// monitor-process.test.ts — legacy daemon 必须绑定到已验证 PID，不操作真进程。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  legacyDaemonPidFilePath,
  type DaemonProcessDependencies,
  retireVerifiedDaemonProcess,
} from '../src/monitor-process.ts';

function fakeDependencies(options: {
  pidFile?: string;
  listeners?: number[];
  command?: string;
}): DaemonProcessDependencies & { terminated: number[] } {
  const terminated: number[] = [];
  return {
    commandLine: () => options.command ?? '/usr/bin/node /repo/dist/cdp.js __daemon',
    listenerPids: () => options.listeners ?? [4312],
    readPidFile: () => options.pidFile ?? '4312\n',
    terminate: pid => terminated.push(pid),
    terminated,
  };
}

test('legacyDaemonPidFilePath: 旧版全局 pid file 只从显式 tmp root 派生', () => {
  assert.equal(legacyDaemonPidFilePath(join('tmp', 'fixture')), join('tmp', 'fixture', 'cdp-listen.pid'));
});

test('retireVerifiedDaemonProcess: PID file/listener/CLI __daemon 三重一致才发信号', () => {
  const dependencies = fakeDependencies({});
  retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo/dist/cdp.js', dependencies);
  assert.deepEqual(dependencies.terminated, [4312]);
});

test('retireVerifiedDaemonProcess: stale PID、多 listener 或 foreign 命令行均 fail closed', () => {
  const cases = [
    fakeDependencies({ pidFile: 'not-a-pid' }),
    fakeDependencies({ listeners: [9999] }),
    fakeDependencies({ listeners: [4312, 9999] }),
    fakeDependencies({ command: '/usr/bin/node /repo/dist/cdp.js worker' }),
    fakeDependencies({ command: '/usr/bin/node /other/dist/cdp.js __daemon' }),
  ];
  for (const dependencies of cases) {
    assert.throws(
      () => retireVerifiedDaemonProcess(9333, '/tmp/cdp-listen.pid', '/repo/dist/cdp.js', dependencies),
      /PID|listener|daemon/i,
    );
    assert.deepEqual(dependencies.terminated, []);
  }
});
