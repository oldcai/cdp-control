/**
 * folds.test.ts — fold 规则文件的纯函数单测(parseRules/domainMatch/pathMatch/hostOf/pathOf/matchFolds)。
 * 读取链 loadFolds 依赖磁盘,用临时 CDP_FOLD_FILE 验证;写操作(addFold/removeFold)已随规则管理命令一并移除。
 * 新格式 5 列:id domain path selector note;旧格式不迁移(非数字 id 行跳过)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRules, domainMatch, pathMatch, hostOf, pathOf, matchFolds, loadFolds } from '../src/folds.ts';

// 每个需要落盘的测试用独立临时 folds 文件,避免互相污染 / 污染真实 dist/fold-selectors.csv。
function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-folds-'));
  const prev = process.env.CDP_FOLD_FILE;
  process.env.CDP_FOLD_FILE = join(dir, 'folds.csv');
  try {
    return fn(dir);
  } finally {
    process.env.CDP_FOLD_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseRules: 新格式 5 列(id/domain/path/selector/note)', () => {
  const txt =
    '# 注释\n\n1\twww.bilibili.com\t/video/*\t#biliMainHeader\t顶栏\n2\t*.zhihu.com\t*\t.AppHeader\t知乎顶栏\n';
  const r = parseRules(txt);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], {
    id: 1,
    domain: 'www.bilibili.com',
    path: '/video/*',
    selector: '#biliMainHeader',
    note: '顶栏',
  });
  assert.deepEqual(r[1], { id: 2, domain: '*.zhihu.com', path: '*', selector: '.AppHeader', note: '知乎顶栏' });
});

test('parseRules: 空 path 列读入为空串', () => {
  const r = parseRules('1\ta.com\t\t.x\tA\n');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { id: 1, domain: 'a.com', path: '', selector: '.x', note: 'A' });
});

test('parseRules: selector 含空格(后代选择器)不被切碎', () => {
  const r = parseRules('1\twww.bilibili.com\t*\t#app > div:nth-of-type(2) > div\t顶栏\n');
  assert.equal(r.length, 1);
  assert.equal(r[0].selector, '#app > div:nth-of-type(2) > div');
});

test('parseRules: 旧格式(首列非数字)整行跳过,不迁移', () => {
  const txt = 'www.bilibili.com\t.a\tA\n2\ta.com\t*\t.x\tB\n';
  const r = parseRules(txt);
  assert.equal(r.length, 1); // 只保留首列为数字的新格式行
  assert.equal(r[0].id, 2);
});

test('parseRules: 无备注(末列空)行不报错;仅域名无 selector 不影响解析', () => {
  assert.deepEqual(parseRules('1\ta.com\t*\t.x\t\n')[0], {
    id: 1,
    domain: 'a.com',
    path: '*',
    selector: '.x',
    note: '',
  });
});

test('domainMatch: 精确域名', () => {
  assert.equal(domainMatch('www.bilibili.com', 'www.bilibili.com'), true);
  assert.equal(domainMatch('www.bilibili.com', 'bilibili.com'), false);
  assert.equal(domainMatch('www.bilibili.com', ''), false);
});

test('domainMatch: *.suffix 通配匹配自身 + 任意子域', () => {
  assert.equal(domainMatch('*.zhihu.com', 'zhihu.com'), true);
  assert.equal(domainMatch('*.zhihu.com', 'www.zhihu.com'), true);
  assert.equal(domainMatch('*.zhihu.com', 'a.b.zhihu.com'), true);
  assert.equal(domainMatch('*.zhihu.com', 'notzhihu.com'), false);
  assert.equal(domainMatch('*.zhihu.com', 'com'), false);
});

test('domainMatch: suffix.* entity 通配匹配所有 TLD', () => {
  assert.equal(domainMatch('zhihu.*', 'zhihu.com'), true);
  assert.equal(domainMatch('zhihu.*', 'zhihu.cn'), true);
  assert.equal(domainMatch('zhihu.*', 'zhihu.net'), true);
  assert.equal(domainMatch('zhihu.*', 'zhihu'), true); // 无 TLD 也匹配
  assert.equal(domainMatch('zhihu.*', 'mzhihu.com'), false); // 前缀不是独立 segment
  assert.equal(domainMatch('zhihu.*', 'notzhihu.com'), false);
});

test('pathMatch: 空 = 不限定', () => {
  assert.equal(pathMatch('', '/anything'), true);
  assert.equal(pathMatch('', ''), true);
});

test('pathMatch: 精确与字面匹配(正则特殊字符转义)', () => {
  assert.equal(pathMatch('/video/BV1', '/video/BV1'), true);
  assert.equal(pathMatch('/video/BV1', '/video/BV2'), false);
  assert.equal(pathMatch('/a.b', '/aXb'), false); // 点按字面,不做通配
  assert.equal(pathMatch('/a?b', '/aXb'), false); // 问号按字面
});

test('pathMatch: * 匹配任意字符含 /', () => {
  assert.equal(pathMatch('/video/*', '/video/123'), true);
  assert.equal(pathMatch('/video/*', '/video/a/b/c'), true);
  assert.equal(pathMatch('/video/*', '/video/'), true);
  assert.equal(pathMatch('/video/*', '/video'), false); // * 至少消费一个字符
  assert.equal(pathMatch('/video/*', '/other/123'), false);
  assert.equal(pathMatch('*', '/anything'), true);
});

test('hostOf: 正常 url 取 hostname;非法/about:blank 返回空串', () => {
  assert.equal(hostOf('https://www.bilibili.com/video/BV1'), 'www.bilibili.com');
  assert.equal(hostOf('about:blank'), '');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});

test('pathOf: 正常 url 取 pathname;无路径返回 /;非法返回空串', () => {
  assert.equal(pathOf('https://www.bilibili.com/video/BV1'), '/video/BV1');
  assert.equal(pathOf('https://www.bilibili.com/'), '/');
  assert.equal(pathOf('about:blank'), '');
  assert.equal(pathOf(undefined), '');
});

test('matchFolds: 空 path 规则只看域名', () => {
  const txt = '1\twww.bilibili.com\t\t#hdr\t顶栏\n';
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.csv'), txt, 'utf8');
    const m = matchFolds('www.bilibili.com', '/video/BV1');
    assert.equal(m.length, 1);
    assert.equal(m[0].selector, '#hdr');
  });
});

test('matchFolds: path glob 规则同域名跨页区分', () => {
  // 同域名两条不同 path 规则:视频页 vs 账户页,验证跨页不互相命中
  const txt =
    '1\twww.bilibili.com\t/video/*\t#videoHdr\t视频页顶栏\n2\twww.bilibili.com\t/account/*\t#accountHdr\t账户页顶栏\n';
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.csv'), txt, 'utf8');
    // 视频页只命中 /video/* 规则(/account/* 不命中)
    let m = matchFolds('www.bilibili.com', '/video/BV1');
    assert.equal(m.length, 1);
    assert.equal(m[0].selector, '#videoHdr');
    // 账户页只命中 /account/* 规则
    m = matchFolds('www.bilibili.com', '/account/home');
    assert.equal(m.length, 1);
    assert.equal(m[0].selector, '#accountHdr');
    // 首页 / 不命中任何带 path 的规则
    m = matchFolds('www.bilibili.com', '/');
    assert.equal(m.length, 0);
  });
});

test('matchFolds: entity 域名 + glob path 组合', () => {
  const txt = '1\tzhihu.*\t/question/*\t.QnA\t问题页\n';
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.csv'), txt, 'utf8');
    assert.equal(matchFolds('www.zhihu.com', '/question/123').length, 1);
    assert.equal(matchFolds('zhihu.com', '/question/123').length, 1);
    assert.equal(matchFolds('zhihu.cn', '/question/123').length, 1);
    assert.equal(matchFolds('www.zhihu.com', '/video/999').length, 0); // path 不命中
    assert.equal(matchFolds('example.com', '/question/123').length, 0); // domain 不命中
  });
});

test('matchFolds: path 规则在 pathname 为空(非法 url)时不命中', () => {
  const txt = '1\twww.bilibili.com\t/video/*\t#videoHdr\t顶栏\n';
  withTmpDir(dir => {
    writeFileSync(join(dir, 'folds.csv'), txt, 'utf8');
    assert.equal(matchFolds('www.bilibili.com', '').length, 0);
  });
});

test('loadFolds: 文件不存在返回空数组', () => {
  withTmpDir(() => {
    assert.deepEqual(loadFolds(), []);
  });
});
