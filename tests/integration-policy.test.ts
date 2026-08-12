import assert from 'node:assert/strict';
import test from 'node:test';
import { browserRequired } from './integration-policy.ts';

test('集成测试仅在显式 CI 门禁下强制要求发现浏览器', () => {
  assert.equal(browserRequired({}), false);
  assert.equal(browserRequired({ CDP_INTEGRATION_REQUIRE_BROWSER: '0' }), false);
  assert.equal(browserRequired({ CDP_INTEGRATION_REQUIRE_BROWSER: '1' }), true);
});
