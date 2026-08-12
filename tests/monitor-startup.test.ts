// monitor-startup.test.ts — daemon 对外可见后的启动顺序纯单测，不监听真端口或写真实 PID。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeBoundDaemon } from '../src/monitor-startup.ts';

test('initializeBoundDaemon: bind 成功后先发布 PID，再进入可能很慢的 initial sync', async () => {
  const calls: string[] = [];

  await initializeBoundDaemon({
    bind: async () => {
      calls.push('bound');
    },
    publishPid: () => {
      calls.push('pid published');
    },
    syncInitialTargets: async () => {
      calls.push('sync started');
      assert.deepEqual(calls, ['bound', 'pid published', 'sync started']);
    },
  });

  assert.deepEqual(calls, ['bound', 'pid published', 'sync started']);
});
