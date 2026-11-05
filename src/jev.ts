/**
 * jev.ts — TypeSafe Jev(System One)的最小 HTTP 客户端与 key 查找。
 *
 * 这是页面内容发往第三方的唯一出口,只被 api.ts 的 findGoal 使用(tests/jev.test.ts 守这条边界)。
 * 失败一律抛 JevError:调用失败是错误,不是答案,绝不能被读成"没找到"。
 * key 不进日志、不进错误信息。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const KEY_NAME = 'JEV_API_KEY';
const MAX_ATTEMPTS = 5;
/** 单次退避上限:服务端要求等得更久就不干等,直接报错交还 agent。 */
const MAX_WAIT_MS = 30_000;
const TIMEOUT_MS = 60_000;
const ERR_BODY_MAX = 300;

export interface JevChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, null> }
export interface JevNoulQuestion { type: 'noul'; instructions: string }
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;
export interface JevRequest { model: string; state: Record<string, string>; questions: Record<string, JevQuestion> }

export interface JevChoiceAnswer { type: 'choice'; probabilities: Record<string, number> }
export interface JevNoulAnswer { type: 'noul'; noul: number }
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;
export interface JevResponse { answers: Record<string, JevAnswer>; usage?: { input_tokens: number } }

export type JevCall = (req: JevRequest) => Promise<JevResponse>;

export class JevError extends Error {
  override name = 'JevError';
}

export interface JevClientOpts {
  key: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** retry-after:秒数或 HTTP 日期;缺失/非法返回 null。 */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** 把 HTTP 错误翻译成 agent 能据以行动的原因。 */
function statusMessage(status: number, body: string): string {
  const detail = body.slice(0, ERR_BODY_MAX);
  if (status === 401) return `Jev API HTTP 401:JEV_API_KEY 无效或缺失。${detail}`;
  if (status === 400 && body.includes('max_tokens_exceeded')) {
    return 'Jev API HTTP 400:页面太大,超过 Jev 上下文上限(max_tokens_exceeded)。改用 view <ref> 看局部。';
  }
  return `Jev API HTTP ${status}:${detail}`;
}

/** 构造带有限退避的调用函数。429/529 按 retry-after(缺失则指数)重试,其余状态不重试。 */
export function jevClient(opts: JevClientOpts): JevCall {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const fail = (msg: string) => new JevError(msg.split(opts.key).join('***'));

  return async (req) => {
    const body = JSON.stringify(req);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      let text: string;
      try {
        res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        text = await res.text();
      } catch (e) {
        throw fail(`Jev API 网络错误:${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 429 || res.status === 529) {
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt;
        if (wait > MAX_WAIT_MS) throw fail(`Jev API 限流/过载(HTTP ${res.status}):服务端要求等待 ${Math.ceil(wait / 1000)} 秒,未重试`);
        if (attempt + 1 >= MAX_ATTEMPTS) throw fail(`Jev API 限流/过载(HTTP ${res.status}):已尝试 ${MAX_ATTEMPTS} 次仍失败`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw fail(statusMessage(res.status, text));
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw fail('Jev API 响应不是 JSON'); }
      if (!parsed || typeof parsed !== 'object' || !('answers' in parsed) || !parsed.answers || typeof parsed.answers !== 'object') {
        throw fail('Jev API 响应缺少 answers');
      }
      return parsed as JevResponse;
    }
  };
}

/** 从 .env 文本取某个变量(支持 export、引号、行尾注释、CRLF)。缺失或为空返回 null。 */
export function parseEnvValue(text: string, name: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line.startsWith(`${name}=`)) continue;
    const rest = line.slice(name.length + 1).trim();
    const quoted = /^(['"])(.*?)\1/.exec(rest);
    const value = quoted ? quoted[2] : rest.replace(/\s+#.*$/, '').trim();
    return value || null;
  }
  return null;
}

export interface KeyLookup { env?: Record<string, string | undefined>; home?: string }

/** key 查找顺序:环境变量 → ~/.cdp-control/.env。只在 find --goal 路径被调用,其余命令不读 key。 */
export function loadJevKey(look: KeyLookup = {}): string | null {
  const fromEnv = (look.env ?? process.env)[KEY_NAME];
  if (fromEnv) return fromEnv;
  try {
    return parseEnvValue(readFileSync(join(look.home ?? homedir(), '.cdp-control', '.env'), 'utf8'), KEY_NAME);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new JevError(`读取 ~/.cdp-control/.env 失败:${(e as Error).message}`);
  }
}

export function requireJevKey(look: KeyLookup = {}): string {
  const key = loadJevKey(look);
  if (!key) throw new JevError(`find --goal 需要 ${KEY_NAME}:设环境变量,或写入 ~/.cdp-control/.env(${KEY_NAME}=...)`);
  return key;
}
