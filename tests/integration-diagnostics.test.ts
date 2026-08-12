import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCommandTranscript } from './integration/harness.ts';

test('集成命令诊断同时标出场景、状态、stdout 与 stderr', () => {
  const transcript = formatCommandTranscript('③ 坐标 click + feedback', {
    code: 1,
    signal: null,
    stdout: 'partial output\n',
    stderr: 'failure detail\n',
  });
  assert.match(transcript, /场景「③ 坐标 click \+ feedback」/);
  assert.match(transcript, /code=1 signal=none/);
  assert.match(transcript, /stdout:\npartial output/);
  assert.match(transcript, /stderr:\nfailure detail/);
});

test('集成命令诊断明确标出空输出流', () => {
  const transcript = formatCommandTranscript('⑧ selector 错误路径', {
    code: 1,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
  });
  assert.match(transcript, /code=1 signal=SIGTERM/);
  assert.match(transcript, /stdout:\n<empty>/);
  assert.match(transcript, /stderr:\n<empty>/);
});

test('集成命令诊断把只有换行的 CRLF/LF 双流视为空', () => {
  const transcript = formatCommandTranscript('① view 建树', {
    code: 0,
    signal: null,
    stdout: '\r\n',
    stderr: '\n',
  });
  assert.match(transcript, /stdout:\n<empty>/);
  assert.match(transcript, /stderr:\n<empty>/);
});
