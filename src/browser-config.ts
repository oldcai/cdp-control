/**
 * browser-config.ts — ~/.cdp-control/browser.json 启动配置解析(纯函数,零 fs 读)。
 * 语义:缺失则生成 / 存在则用 / 损坏抛清晰错误(调用方警告、不兜底) / 用户可改。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserKind } from './browser-discover';

export interface BrowserConfig {
  exe: string; kind: BrowserKind; args: string[]; port: number; userData: string;
}

export function browserConfigPath(): string {
  return join(homedir(), '.cdp-control', 'browser.json');
}

export const DEFAULT_PORT = 9222;
export const DEFAULT_USER_DATA = () => join(homedir(), '.cdp-control', 'user-data');

/** browser.json 存在时配置端口权威；无配置 bootstrap 也固定用 9222。 */
export function effectiveBrowserPort(config: Pick<BrowserConfig, 'port'> | null): number {
  return config?.port ?? DEFAULT_PORT;
}

const KINDS: BrowserKind[] = ['edge', 'chrome', 'chromium', 'brave', 'arc'];

/** 解析 browser.json 文本;损坏则抛清晰错误(供调用方警告、不兜底)。port/userData 缺省取默认值,显式非法则判坏。 */
export function parseBrowserConfig(text: string): BrowserConfig {
  let obj: any;
  try { obj = JSON.parse(text); } catch (e: any) { throw new Error(`browser.json 不是合法 JSON: ${e.message}`); }
  if (!obj || typeof obj.exe !== 'string' || !obj.exe.trim()) throw new Error('browser.json 缺 exe(浏览器可执行文件绝对路径)');
  if (obj.kind != null && !KINDS.includes(obj.kind)) throw new Error(`browser.json 的 kind 非法: ${obj.kind}(应为 ${KINDS.join('|')})`);
  if (obj.args != null && !Array.isArray(obj.args)) throw new Error('browser.json 的 args 必须是字符串数组');
  if (Array.isArray(obj.args) && obj.args.some((a: unknown) => typeof a !== 'string')) throw new Error('browser.json 的 args 必须全是字符串');
  const port = obj.port == null ? DEFAULT_PORT : Number(obj.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`browser.json 的 port 非法: ${obj.port}(应为 1-65535 整数)`);
  const userData = (typeof obj.userData === 'string' && obj.userData.trim()) ? obj.userData.trim() : DEFAULT_USER_DATA();
  return { exe: obj.exe.trim(), kind: obj.kind || 'chrome', args: Array.isArray(obj.args) ? obj.args : [], port, userData };
}

/** 首次生成配置时的默认 args(用户改过则以用户为准,工具不覆盖)。 */
export function defaultArgs(platform: string = process.platform): string[] {
  const args = [
    '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--window-size=1200,800',
  ];
  if (platform === 'linux') args.push('--disable-dev-shm-usage');
  return args;
}
