/**
 * feedback.test.ts — 反馈纯函数单测(零运行时依赖,node:test)。
 * feedback.ts 的 DOM 部分(startFeedback/collectFeedback 装 observer、buildView 采集)依赖
 * 真实 DOM,靠浏览器实测验收;这里只锁定可纯化的 foldTimestampRun(连续播放时间戳折叠判定)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffClassTokens,
  foldTimestampRun,
  limitFeedbackAttrs,
  type FeedbackAttr,
  type FeedbackChange,
} from '../src/inject/lib/feedback.ts';

const ch = (before: string, after: string): FeedbackChange => ({ before, after });

test('foldTimestampRun: 连续 ≥3 条同格式时间戳折叠为一条,note 标 N', () => {
  const cs = [ch('01:55', '01:56'), ch('01:56', '01:57'), ch('01:57', '01:58'), ch('01:58', '01:59')];
  const out = foldTimestampRun(cs);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { before: '01:55', after: '01:59', note: '播放进度,已折叠 4 条' });
});

test('foldTimestampRun: 3 条正好折叠,2 条不折叠(偶发同名不收)', () => {
  const three = [ch('00:01', '00:02'), ch('00:02', '00:03'), ch('00:03', '00:04')];
  assert.equal(foldTimestampRun(three).length, 1);
  const two = [ch('00:01', '00:02'), ch('00:02', '00:03')];
  // runLen<3 原样保留
  assert.equal(foldTimestampRun(two).length, 2);
});

test('foldTimestampRun: 纯数字计数(点赞数 1402→1403→1404)不折叠,保留为真信号', () => {
  const cs = [ch('1402', '1403'), ch('1403', '1404'), ch('1404', '1405'), ch('1405', '1406')];
  const out = foldTimestampRun(cs);
  // 不匹配 \d{1,2}:\d{2},逐条原样保留
  assert.equal(out.length, 4);
  assert.equal(out[0].note, undefined);
});

test('foldTimestampRun: 时间戳序列被真变化(纯数字)打断时,前段折叠、后段保留', () => {
  const cs = [
    ch('01:55', '01:56'), ch('01:56', '01:57'), ch('01:57', '01:58'), // 3 条时间戳(折叠)
    ch('1402', '1403'),                                                 // 真变化(打断)
    ch('05:00', '05:01'), ch('05:01', '05:02'),                        // 仅 2 条(不折叠)
  ];
  const out = foldTimestampRun(cs);
  // 折叠 1 + 真变化 1 + 2 条未折叠 = 4 条
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { before: '01:55', after: '01:58', note: '播放进度,已折叠 3 条' });
  assert.deepEqual(out[1], ch('1402', '1403'));
  assert.deepEqual(out[2], ch('05:00', '05:01'));
  assert.deepEqual(out[3], ch('05:01', '05:02'));
});

test('foldTimestampRun: 缺 before 的变化不进时间戳序列(原样保留)', () => {
  const cs: FeedbackChange[] = [{ after: '01:56' }, ch('01:56', '01:57'), ch('01:57', '01:58')];
  const out = foldTimestampRun(cs);
  // 首条无 before 不算时间戳序列起点 → 不折叠,后 2 条 runLen<3 也不折叠 → 3 条原样
  assert.equal(out.length, 3);
});

test('foldTimestampRun: 空数组 / 单条 不报错', () => {
  assert.deepEqual(foldTimestampRun([]), []);
  const one = [ch('01:55', '01:56')];
  assert.deepEqual(foldTimestampRun(one), one);
});

test('foldTimestampRun: 时间戳边界格式(H:MM / HH:MM 都接受)', () => {
  // \d{1,2}:\d{2} 既匹配 "9:05" 也匹配 "59:59"
  const cs = [ch('9:05', '9:06'), ch('9:06', '9:07'), ch('9:07', '9:08')];
  assert.equal(foldTimestampRun(cs).length, 1);
  const cs2 = [ch('59:58', '59:59'), ch('59:59', '1:00:00')]; // 末条不是分:秒格式
  // 第一条匹配,第二条 after "1:00:00" 不匹配 → 仅 1 条进序列(runLen<3)→ 2 条原样
  assert.equal(foldTimestampRun(cs2).length, 2);
});

test('diffClassTokens: 只返回 class token 差集并保持两侧原顺序', () => {
  assert.deepEqual(
    diffClassTokens('Button Button--grey compact', 'Button Button--red compact active'),
    { added: ['Button--red', 'active'], removed: ['Button--grey'] },
  );
});

test('diffClassTokens: 仅重排/重复/空白变化时差集为空', () => {
  assert.deepEqual(diffClassTokens('a  b a', ' b\ta '), { added: [], removed: [] });
  assert.deepEqual(diffClassTokens(null, 'ready'), { added: ['ready'], removed: [] });
  assert.deepEqual(diffClassTokens('ready', null), { added: [], removed: ['ready'] });
});

test('limitFeedbackAttrs: 条目去重后最多 20 条并返回溢出数', () => {
  const attrs: FeedbackAttr[] = Array.from({ length: 21 }, (_, i) => ({
    desc: `button[ref=${i}]`, attr: 'aria-pressed', before: 'false', after: 'true',
  }));
  attrs.splice(3, 0, attrs[2]); // 完全重复的条目不占限额
  const out = limitFeedbackAttrs(attrs);
  assert.equal(out.attrs.length, 20);
  assert.equal(out.overflow, 1);
  assert.deepEqual(out.attrs[0], attrs[0]);
  assert.deepEqual(out.attrs[19], attrs[20]);
});
