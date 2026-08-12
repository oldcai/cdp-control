/**
 * browser-config.ts — <CDP_HOME>/browser.json 启动配置解析(默认 CDP_HOME=~/.cdp-control;零 fs 读)。
 * 语义:缺失则生成 / 存在则用 / 损坏抛清晰错误(调用方警告、不兜底) / 用户可改。
 */
import { join } from 'node:path';
import type { BrowserKind } from './browser-discover';
import { cdpHome, type CdpEnvironment } from './paths.ts';

export interface BrowserConfig {
  exe: string;
  kind: BrowserKind;
  args: string[];
  port: number;
  userData: string;
}

export function browserConfigPath(environment: CdpEnvironment = process.env): string {
  return join(cdpHome(environment), 'browser.json');
}

export const DEFAULT_PORT = 9222;
export const DEFAULT_USER_DATA = (environment: CdpEnvironment = process.env) => join(cdpHome(environment), 'user-data');

const KINDS: BrowserKind[] = ['edge', 'chrome', 'chromium', 'brave', 'arc'];

function isBrowserKind(value: unknown): value is BrowserKind {
  return typeof value === 'string' && KINDS.some(kind => kind === value);
}

/** 解析 browser.json 文本;损坏则抛清晰错误(供调用方警告、不兜底)。port/userData 缺省取默认值,显式非法则判坏。 */
export function parseBrowserConfig(text: string, environment: CdpEnvironment = process.env): BrowserConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`browser.json 不是合法 JSON: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('browser.json 缺 exe(浏览器可执行文件绝对路径)');
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.exe !== 'string' || !obj.exe.trim()) throw new Error('browser.json 缺 exe(浏览器可执行文件绝对路径)');
  if (obj.kind != null && !isBrowserKind(obj.kind))
    throw new Error(`browser.json 的 kind 非法: ${String(obj.kind)}(应为 ${KINDS.join('|')})`);
  if (obj.args != null && !Array.isArray(obj.args)) throw new Error('browser.json 的 args 必须是字符串数组');
  if (Array.isArray(obj.args) && obj.args.some((a: unknown) => typeof a !== 'string'))
    throw new Error('browser.json 的 args 必须全是字符串');
  const port = obj.port == null ? DEFAULT_PORT : Number(obj.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`browser.json 的 port 非法: ${String(obj.port)}(应为 1-65535 整数)`);
  const userData =
    typeof obj.userData === 'string' && obj.userData.trim() ? obj.userData.trim() : DEFAULT_USER_DATA(environment);
  return {
    exe: obj.exe.trim(),
    kind: isBrowserKind(obj.kind) ? obj.kind : 'chrome',
    args: Array.isArray(obj.args) ? (obj.args as string[]) : [],
    port,
    userData,
  };
}

/** 首次生成配置时的默认 args(用户改过则以用户为准,工具不覆盖)。 */
export function defaultArgs(platform: string = process.platform): string[] {
  const args = [
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--window-size=1200,800',
  ];
  if (platform === 'linux') args.push('--disable-dev-shm-usage');
  return args;
}
