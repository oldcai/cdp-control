/**
 * jev.test.ts — Jev 客户端与 key 查找。全部用注入的 fake fetch/sleep,单测不访问真实 API。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevClient, loadJevKey, requireJevKey, parseEnvValue, JevError, type JevRequest } from '../src/jev.ts';

const KEY = 'sk-test-secret-key';
const REQ: JevRequest = { model: 'jev-1.14.0', state: { elements: 'r1: a' }, questions: { e: { type: 'noul', instructions: 'q' } } };
const OK = { answers: { e: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 5 } };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

function harness(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra call');
    if (r instanceof Error) throw r;
    return r;
  };
  const call = jevClient({ key: KEY, fetch: fetchImpl as typeof fetch, sleep: async (ms) => { sleeps.push(ms); } });
  return { call, calls, sleeps };
}

test('jevClient: POST 正确接口,带 Bearer key 与 JSON 体,返回解析结果', async () => {
  const h = harness([json(OK)]);
  assert.deepEqual(await h.call(REQ), OK);
  assert.equal(h.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(h.calls[0].init.method, 'POST');
  const headers = new Headers(h.calls[0].init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(h.calls[0].init.body)), REQ);
});

test('jevClient: 429 按 retry-after 退避后成功', async () => {
  const h = harness([json({}, 429, { 'retry-after': '3' }), json(OK)]);
  assert.deepEqual(await h.call(REQ), OK);
  assert.deepEqual(h.sleeps, [3000]);
});

test('jevClient: 429 无 retry-after 走指数退避,529 同样重试', async () => {
  const h = harness([json({}, 429), json({}, 529), json(OK)]);
  await h.call(REQ);
  assert.deepEqual(h.sleeps, [1000, 2000]);
});

test('jevClient: 429 重试耗尽抛错,次数有限', async () => {
  const h = harness(Array.from({ length: 10 }, () => json({}, 429)));
  await assert.rejects(h.call(REQ), (e: unknown) => e instanceof JevError && /429/.test(e.message) && /限流/.test(e.message));
  assert.equal(h.calls.length, 5);
});

test('jevClient: retry-after 超过上限不干等,直接报错', async () => {
  const h = harness([json({}, 429, { 'retry-after': '3600' })]);
  await assert.rejects(h.call(REQ), /3600/);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.calls.length, 1);
});

test('jevClient: 4xx/5xx 不重试,错误含状态码', async () => {
  for (const status of [400, 401, 422, 500, 503]) {
    const h = harness([json({ detail: 'nope' }, status)]);
    await assert.rejects(h.call(REQ), (e: unknown) => e instanceof JevError && e.message.includes(String(status)));
    assert.equal(h.calls.length, 1);
  }
});

test('jevClient: 401 提示 key 无效', async () => {
  await assert.rejects(harness([json({}, 401)]).call(REQ), /key/i);
});

test('jevClient: max_tokens_exceeded 指出页面太大', async () => {
  await assert.rejects(harness([json({ detail: 'max_tokens_exceeded' }, 400)]).call(REQ), /太大/);
});

test('jevClient: 网络错误抛 JevError', async () => {
  const h = harness([new TypeError('fetch failed')]);
  await assert.rejects(h.call(REQ), (e: unknown) => e instanceof JevError && /fetch failed/.test(e.message));
});

test('jevClient: 200 但非 JSON 或缺 answers 也是错误', async () => {
  await assert.rejects(harness([new Response('<html>', { status: 200 })]).call(REQ), JevError);
  await assert.rejects(harness([json({ model: 'x' })]).call(REQ), JevError);
});

test('jevClient: 错误信息绝不含 key,即使服务端回显', async () => {
  const h = harness([json({ detail: `bad token ${KEY}` }, 401)]);
  await assert.rejects(h.call(REQ), (e: unknown) => e instanceof Error && !e.message.includes(KEY));
  const n = harness([new Error(`connect ${KEY}`)]);
  await assert.rejects(n.call(REQ), (e: unknown) => e instanceof Error && !e.message.includes(KEY));
});

test('parseEnvValue: 支持 export、引号、注释、CRLF', () => {
  assert.equal(parseEnvValue('A=1\nJEV_API_KEY=abc\n', 'JEV_API_KEY'), 'abc');
  assert.equal(parseEnvValue('export JEV_API_KEY="abc"\r\n', 'JEV_API_KEY'), 'abc');
  assert.equal(parseEnvValue("JEV_API_KEY='abc' # x\n", 'JEV_API_KEY'), 'abc');
  assert.equal(parseEnvValue('JEV_API_KEY=abc # note\n', 'JEV_API_KEY'), 'abc');
  assert.equal(parseEnvValue('# JEV_API_KEY=old\nNOT_JEV_API_KEY=x\n', 'JEV_API_KEY'), null);
  assert.equal(parseEnvValue('JEV_API_KEY=\n', 'JEV_API_KEY'), null);
});

function homeWith(content?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'jev-key-'));
  if (content !== undefined) {
    mkdirSync(join(home, '.cdp-control'));
    writeFileSync(join(home, '.cdp-control', '.env'), content);
  }
  return home;
}

test('loadJevKey: 环境变量优先,否则读 ~/.cdp-control/.env,都没有返回 null', () => {
  const home = homeWith('JEV_API_KEY=from-file\n');
  try {
    assert.equal(loadJevKey({ env: { JEV_API_KEY: 'from-env' }, home }), 'from-env');
    assert.equal(loadJevKey({ env: { JEV_API_KEY: '' }, home }), 'from-file');
    assert.equal(loadJevKey({ env: {}, home }), 'from-file');
  } finally { rmSync(home, { recursive: true }); }
  const empty = homeWith();
  try { assert.equal(loadJevKey({ env: {}, home: empty }), null); } finally { rmSync(empty, { recursive: true }); }
});

test('requireJevKey: 没有 key 明确报错并指路', () => {
  const home = homeWith();
  try {
    assert.throws(() => requireJevKey({ env: {}, home }), /JEV_API_KEY.*\.cdp-control\/\.env/s);
    assert.equal(requireJevKey({ env: { JEV_API_KEY: 'k' }, home }), 'k');
  } finally { rmSync(home, { recursive: true }); }
});

// —— 外呼边界:只有 --goal 路径能碰到 Jev ——

const srcFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []);

test('外呼边界: 只有 jev.ts 知道接口地址,只有 api.ts 的 findGoal 构造客户端', () => {
  const root = join(process.cwd(), 'src');
  const files = srcFiles(root);
  const hasHost = files.filter(f => readFileSync(f, 'utf8').includes('api.typesafe.ai'));
  assert.deepEqual(hasHost.map(f => f.slice(root.length + 1)), ['jev.ts']);
  const clients = files.filter(f => /\bjevClient\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(clients.map(f => f.slice(root.length + 1)).sort(), ['api.ts', 'jev.ts']);
  const api = readFileSync(join(root, 'api.ts'), 'utf8');
  assert.equal(api.match(/\bjevClient\(/g)?.length, 1);
});
