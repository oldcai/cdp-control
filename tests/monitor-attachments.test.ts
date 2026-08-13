import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentRegistry, type ClosableAttachment } from '../src/monitor-attachments.ts';

interface FakeAttachment extends ClosableAttachment<unknown> {
  name: string;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error('deferred fixture 未初始化');
      resolvePromise();
    },
  };
}

test('AttachmentRegistry: 重叠 ensure 在首轮完成前不会为同 target 重复连接', async () => {
  const gate = deferred();
  const connections: FakeAttachment[] = [];
  const registry = new AttachmentRegistry<string, FakeAttachment>({
    attach: async () => gate.promise,
    connect: async target => {
      const attachment = { close: () => {}, name: target, onclose: null };
      connections.push(attachment);
      return attachment;
    },
    targetId: target => target,
  });

  const first = registry.ensure('tab-a');
  await Promise.resolve();
  await registry.ensure('tab-a');
  assert.equal(connections.length, 1);
  assert.equal(registry.size, 0);

  gate.resolve();
  await first;
  assert.equal(registry.size, 1);
});

test('AttachmentRegistry: ensureAll 并行启动不同 target，使 initial sync 上界不随 tab 数线性增长', async () => {
  const gates = new Map([
    ['tab-a', deferred()],
    ['tab-b', deferred()],
  ]);
  const connected: string[] = [];
  const registry = new AttachmentRegistry<string, FakeAttachment>({
    attach: async attachment => {
      const gate = gates.get(attachment.name);
      if (!gate) throw new Error('缺少 target gate');
      await gate.promise;
    },
    connect: async target => {
      connected.push(target);
      return { close: () => {}, name: target, onclose: null };
    },
    targetId: target => target,
  });

  const all = registry.ensureAll(['tab-a', 'tab-b'], 2);
  await Promise.resolve();
  assert.deepEqual(connected, ['tab-a', 'tab-b']);
  gates.get('tab-a')?.resolve();
  gates.get('tab-b')?.resolve();
  await all;
  assert.equal(registry.size, 2);
});

test('AttachmentRegistry: 大 target 列表按有界批次轮转，重叠 ensureAll 不突破并发上限', async () => {
  const gates: Array<ReturnType<typeof deferred>> = [];
  const connected: string[] = [];
  const registry = new AttachmentRegistry<string, FakeAttachment>({
    attach: async attachment => {
      const index = Number(attachment.name.slice(4));
      const gate = gates[index];
      if (!gate) throw new Error('缺少 target gate');
      await gate.promise;
    },
    connect: async target => {
      connected.push(target);
      return { close: () => {}, name: target, onclose: null };
    },
    targetId: target => target,
  });
  const targets = Array.from({ length: 12 }, (_unused, index) => {
    gates.push(deferred());
    return `tab-${index}`;
  });

  const first = registry.ensureAll(targets, 3);
  await Promise.resolve();
  const overlap = registry.ensureAll(targets, 3);
  await Promise.resolve();
  assert.deepEqual(connected, ['tab-0', 'tab-1', 'tab-2']);
  for (const gate of gates.slice(0, 3)) gate.resolve();
  await Promise.all([first, overlap]);

  const second = registry.ensureAll(targets, 3);
  await Promise.resolve();
  assert.deepEqual(connected, ['tab-0', 'tab-1', 'tab-2', 'tab-3', 'tab-4', 'tab-5']);
  for (const gate of gates.slice(3, 6)) gate.resolve();
  await second;
});

test('AttachmentRegistry: 旧 attachment close 不会删除同 id 的替代 attachment', async () => {
  const connections: FakeAttachment[] = [];
  const registry = new AttachmentRegistry<string, FakeAttachment>({
    attach: async () => {},
    connect: async target => {
      const attachment = { close: () => {}, name: `${target}-${connections.length}`, onclose: null };
      connections.push(attachment);
      return attachment;
    },
    targetId: target => target,
  });

  await registry.ensure('tab-a');
  const first = connections[0];
  assert.ok(first);
  first.onclose?.();
  await registry.ensure('tab-a');
  const second = connections[1];
  assert.ok(second);
  assert.equal(registry.size, 1);

  first.onclose?.();
  assert.equal(registry.size, 1);
  second.onclose?.();
  assert.equal(registry.size, 0);
});

test('AttachmentRegistry: attach 与 close 同时失败也释放 in-flight，下一轮可重试', async () => {
  let attempts = 0;
  const registry = new AttachmentRegistry<string, FakeAttachment>({
    attach: async () => {
      if (attempts === 1) throw new Error('attach fixture');
    },
    connect: async target => {
      attempts++;
      return {
        close: () => {
          if (attempts === 1) throw new Error('close fixture');
        },
        name: target,
        onclose: null,
      };
    },
    targetId: target => target,
  });

  await registry.ensure('tab-a');
  await registry.ensure('tab-a');
  assert.equal(attempts, 2);
  assert.equal(registry.size, 1);
});
