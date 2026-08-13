import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnDetachedDaemon } from '../src/monitor-spawn.ts';

test('spawnDetachedDaemon: 异步 spawn error 被捕获为 rejection，不成为 unhandled error', async () => {
  await assert.rejects(
    spawnDetachedDaemon('/definitely/missing/cdp-control-node', ['daemon.js', '__daemon'], {}),
    /启动 monitor daemon|ENOENT|spawn/i,
  );
});
