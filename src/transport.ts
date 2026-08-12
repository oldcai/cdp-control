/**
 * transport.ts — 低级 CDP 连接与 target 级原语。
 * 依赖 Node >= 21 自带全局 WebSocket / fetch,零 npm 运行时包。仅被 api/monitor/browser 依赖。
 */

export const HOST = process.env.CDP_HOST || '127.0.0.1';
// 端口默认为 env CDP_PORT 或 9222;浏览器配置 browser.json 的 port 由 ensureBrowser 经 setPort 同步进来。
export let PORT: string | number = process.env.CDP_PORT || 9222;
export let CONNECTION_HOST = httpHost(HOST);
export let BASE = `http://${CONNECTION_HOST}:${PORT}`;

function httpHost(host: string): string {
  const trimmed = host.trim();
  if (/^\[[^\]]+\]$/.test(trimmed)) return trimmed;
  return trimmed.includes(':') ? `[${trimmed}]` : trimmed;
}

/** 多地址 hostname 中选中健康 CDP 后 pin 低级传输，避免后续请求又命中非 CDP 地址。 */
export function setEndpointHost(host: string): void {
  CONNECTION_HOST = httpHost(host);
  BASE = `http://${CONNECTION_HOST}:${PORT}`;
}

export function setPort(p: string | number): void {
  PORT = p;
  BASE = `http://${CONNECTION_HOST}:${p}`;
}

export interface Target {
  id: string;
  type?: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpError {
  message?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: CdpError;
}

export interface BrowserVersion {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

interface RuntimeEvaluateResult {
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
  result?: { value?: unknown };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTarget(value: unknown): value is Target {
  return isRecord(value) && typeof value.id === 'string' && typeof value.url === 'string';
}

export async function getJson<T = unknown>(path: string, timeoutMs = 5000): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} GET ${path}`);
  return r.json() as Promise<T>;
}

// 轮询等待的通用 sleep(CLI/daemon 多处复用)。
export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function wsConnect(url: string, timeout = 8000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error: unknown) {
      return reject(new Error(`创建 WebSocket 失败: ${errorMessage(error)}`));
    }
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`连接超时: ${url}`));
    }, timeout);
    ws.onopen = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error(`WebSocket 连接失败: ${url}`));
    };
  });
}

let seq = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string }
>();

export function attachDispatcher(ws: WebSocket, onEvent?: (method: string, params: unknown) => void): void {
  ws.onmessage = ev => {
    let msg: CdpMessage;
    try {
      const parsed: unknown = JSON.parse(String(ev.data));
      if (!isRecord(parsed)) return;
      msg = parsed;
    } catch {
      return;
    }
    if (msg.id === undefined) {
      if (onEvent) {
        try {
          onEvent(typeof msg.method === 'string' ? msg.method : '', msg.params);
        } catch {}
      }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${p.method} → ${msg.error.message}`));
    else p.resolve(msg.result);
  };
}

export function send<T = unknown>(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  timeout = 20000,
): Promise<T> {
  const id = ++seq;
  const response = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`命令超时: ${method}`));
    }, timeout);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return response.then(result => result as T);
}

// ---- target 发现 / 选择 ----

// /json/list 按「最近激活」排序:第一项即浏览器当前前台 tab(实测 Target.activateTarget 会把目标移到首位)。
// 这一不变量同时支撑 list 的前台标记与 resolveTarget 的默认选择(无 match 取第一个普通网页即前台)。
// 过滤只剔除 devtools(永不为前台),不影响哪个真 page 排首位。
export async function listTargets(): Promise<Target[]> {
  const all = await getJson<unknown>('/json/list');
  if (!Array.isArray(all)) throw new Error('/json/list 返回值不是数组');
  return all.filter(isTarget).filter(t => t.type === 'page' && !/^devtools:\/\//.test(t.url || ''));
}

export function resolveTarget(list: Target[], match?: string): Target {
  if (list.length === 0) throw new Error('浏览器里没有可用的 page tab');
  if (!match) {
    return list.find(t => !/^(about:|edge:\/\/|chrome:\/\/|devtools:)/.test(t.url || '')) || list[0];
  }
  const exact = list.find(t => t.id === match);
  if (exact) return exact;
  const subs = list.filter(
    t => (t.id || '').includes(match) || (t.url || '').includes(match) || (t.title || '').includes(match),
  );
  const sub = subs.find(t => !/^devtools:\/\//.test(t.url || '')) || subs[0];
  if (sub) return sub;
  throw new Error(
    `没有找到匹配 "${match}" 的 tab。可用: ${list.map(t => t.id.slice(0, 8) + ':' + (t.title || t.url).slice(0, 30)).join(' | ')}`,
  );
}

// ---- 页面级连接与执行 ----

export async function pageWs(target: Target, onEvent?: (method: string, params: unknown) => void): Promise<WebSocket> {
  if (!target.webSocketDebuggerUrl) throw new Error('该 target 没有调试地址');
  const ws = await wsConnect(target.webSocketDebuggerUrl);
  attachDispatcher(ws, onEvent);
  return ws;
}

export async function browserWs(): Promise<WebSocket> {
  const v = await getJson<BrowserVersion>('/json/version');
  if (typeof v.webSocketDebuggerUrl !== 'string') {
    throw new Error('/json/version 缺少 webSocketDebuggerUrl');
  }
  const ws = await wsConnect(v.webSocketDebuggerUrl);
  attachDispatcher(ws);
  return ws;
}

export async function evalJs(ws: WebSocket, expression: string, timeout = 20000): Promise<unknown> {
  const r = await send<RuntimeEvaluateResult>(
    ws,
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    },
    timeout,
  );
  if (r.exceptionDetails) {
    const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error(`页面执行出错: ${desc}`);
  }
  return r.result?.value;
}

// ---- target 级高层原语(api 与 monitor 共用) ----

/** 在 target 执行 JS,返回 returnByValue 的值。用 try/finally 保证即使 evalJs 抛错也关闭 ws,
 * 否则异常路径漏掉 ws.close() 会让连接一直开着,Node 事件循环不空 → run 脚本结束后进程挂住不退出。 */
export async function evaluate(target: Target, expression: string, timeout?: number): Promise<unknown> {
  const ws = await pageWs(target);
  try {
    return await evalJs(ws, expression, timeout);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

/** 用 id 或 url/title 子串定位 target;不传则取第一个普通网页。 */
export async function resolve(match?: string): Promise<Target> {
  return resolveTarget(await listTargets(), match);
}

/** 列出所有 page tab(含手动开的)。 */
export async function list(): Promise<Target[]> {
  return listTargets();
}
