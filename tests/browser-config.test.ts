// browser-config.test.ts — browser.json 解析 + defaultArgs 单测(纯函数)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserConfig, defaultArgs, browserConfigPath, effectiveBrowserPort, DEFAULT_PORT, DEFAULT_USER_DATA } from '../src/browser-config.ts';

test('parseBrowserConfig: 合法 JSON 解析(含 port/userData)', () => {
  const c = parseBrowserConfig('{ "exe": "/x/msedge.exe", "kind": "edge", "args": ["--no-first-run"], "port": 9333, "userData": "/data" }');
  assert.equal(c.exe, '/x/msedge.exe');
  assert.equal(c.kind, 'edge');
  assert.deepEqual(c.args, ['--no-first-run']);
  assert.equal(c.port, 9333);
  assert.equal(c.userData, '/data');
});

test('parseBrowserConfig: port/userData 缺省取默认值', () => {
  const c = parseBrowserConfig('{ "exe": "/x/msedge.exe" }');
  assert.deepEqual(c.args, []);
  assert.equal(c.port, DEFAULT_PORT);
  assert.equal(c.userData, DEFAULT_USER_DATA());
});

test('parseBrowserConfig: 显式 port 非法抛清晰错', () => {
  assert.throws(() => parseBrowserConfig('{ "exe": "/x", "port": "abc" }'), /port 非法/);
  assert.throws(() => parseBrowserConfig('{ "exe": "/x", "port": 70000 }'), /port 非法/);
});

test('parseBrowserConfig: 非 JSON 抛清晰错', () => {
  assert.throws(() => parseBrowserConfig('not json'), /不是合法 JSON/);
});

test('parseBrowserConfig: 缺 exe 抛清晰错', () => {
  assert.throws(() => parseBrowserConfig('{ "kind": "edge" }'), /缺 exe/);
});

test('parseBrowserConfig: args 非数组抛清晰错', () => {
  assert.throws(() => parseBrowserConfig('{ "exe": "/x", "args": "nope" }'), /args 必须是/);
});

test('parseBrowserConfig: kind 非法抛清晰错', () => {
  assert.throws(() => parseBrowserConfig('{ "exe": "/x", "kind": "netscape" }'), /kind 非法/);
});

test('defaultArgs: 通用集 + linux 加 disable-dev-shm-usage', () => {
  assert.ok(defaultArgs('win32').includes('--remote-allow-origins=*'));
  assert.ok(defaultArgs('win32').some(a => a.startsWith('--window-size=')));
  assert.ok(defaultArgs('linux').includes('--disable-dev-shm-usage'));
  assert.ok(!defaultArgs('win32').includes('--disable-dev-shm-usage'));
});

test('browserConfigPath: 落在 ~/.cdp-control/browser.json', () => {
  assert.match(browserConfigPath(), /\.cdp-control[\\/]browser\.json$/);
});

test('effectiveBrowserPort: 配置端口权威；无配置固定 9222，不受 CDP_PORT 漂移', () => {
  assert.equal(effectiveBrowserPort({ port: 24444 }), 24444);
  assert.equal(effectiveBrowserPort(null), DEFAULT_PORT);
});
