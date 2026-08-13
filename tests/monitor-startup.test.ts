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
    rollbackBind: async () => {
      calls.push('listener closed');
    },
    syncInitialTargets: async () => {
      calls.push('sync started');
      assert.deepEqual(calls, ['bound', 'pid published', 'sync started']);
    },
  });

  assert.deepEqual(calls, ['bound', 'pid published', 'sync started']);
});

test('initializeBoundDaemon: PID 发布失败会关闭已绑定 listener，保留原错误且不进入 sync', async () => {
  const calls: string[] = [];
  const publishError = new Error('read-only CDP_HOME');

  await assert.rejects(
    initializeBoundDaemon({
      bind: async () => {
        calls.push('bound');
      },
      publishPid: () => {
        calls.push('publish failed');
        throw publishError;
      },
      rollbackBind: async () => {
        calls.push('listener closed');
      },
      syncInitialTargets: async () => {
        calls.push('sync started');
      },
    }),
    error => error === publishError,
  );

  assert.deepEqual(calls, ['bound', 'publish failed', 'listener closed']);
});

test('initializeBoundDaemon: initial sync 失败会撤销 PID 并关闭 listener，不能宣称 ready', async () => {
  const calls: string[] = [];
  const syncError = new Error('CDP unavailable');

  await assert.rejects(
    initializeBoundDaemon({
      bind: async () => calls.push('bound'),
      publishPid: () => calls.push('pid published'),
      rollbackBind: async () => calls.push('listener closed'),
      rollbackPid: () => calls.push('pid removed'),
      syncInitialTargets: async () => {
        calls.push('sync failed');
        throw syncError;
      },
    }),
    error => error === syncError,
  );

  assert.deepEqual(calls, ['bound', 'pid published', 'sync failed', 'pid removed', 'listener closed']);
});
