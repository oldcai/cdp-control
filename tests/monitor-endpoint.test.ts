// monitor-endpoint.test.ts — daemon 子进程端点快照纯函数测试，不启动真实 daemon/browser。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { daemonChildEnvironment } from '../src/monitor-endpoint.ts';
import { daemonIdentity } from '../src/monitor-health.ts';

test('daemonChildEnvironment: spawn 始终继承同一份 pin 后 identity 快照', () => {
  const expected = daemonIdentity({ CDP_HOME: join('tmp', 'monitor-home') }, join('fake', 'home'), '[::1]', 43111);
  const environment = daemonChildEnvironment(
    {
      CDP_HOME: join('tmp', 'monitor-home'),
      CDP_HOST: 'localhost',
      CDP_PORT: '9222',
      CDP_LOGS_PORT: '19333',
      CDP_NO_AUTOSTART: '1',
    },
    expected,
    19444,
  );

  assert.equal(environment.CDP_HOME, expected.home);
  assert.equal(environment.CDP_HOST, '[::1]');
  assert.equal(environment.CDP_PORT, '43111');
  assert.equal(environment.CDP_LOGS_PORT, '19444');
  assert.equal(environment.CDP_NO_AUTOSTART, '1');
  assert.deepEqual(
    daemonIdentity(environment, join('unused', 'home'), environment.CDP_HOST ?? '', environment.CDP_PORT ?? ''),
    expected,
  );
});
