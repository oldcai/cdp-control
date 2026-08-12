/**
 * paths.ts — cdp-control 数据 home 定位(最底层,不依赖其它项目模块)。
 *
 * 运行时默认使用 ~/.cdp-control;CDP_HOME 为测试和多实例提供受支持的
 * 整体隔离入口。env/home 可注入,便于跨平台纯函数单测。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CdpEnvironment {
  readonly [name: string]: string | undefined;
}

export function cdpHome(environment: CdpEnvironment = process.env, fallbackHome: string = homedir()): string {
  return environment.CDP_HOME || join(fallbackHome, '.cdp-control');
}

const DEFAULT_LOGS_PORT = 9333;
const ISOLATED_LOGS_PORT_BASE = 20_000;
const ISOLATED_LOGS_PORT_SPAN = 20_000;

/**
 * 日志 daemon 端口。默认 home 保持历史端口 9333；自定义 CDP_HOME 用规范化路径
 * 稳定派生高位端口，避免测试/多实例在未显式设 CDP_LOGS_PORT 时误共享 daemon。
 */
export function cdpLogsPort(environment: CdpEnvironment = process.env, fallbackHome: string = homedir()): number {
  const explicit = Number(environment.CDP_LOGS_PORT);
  if (environment.CDP_LOGS_PORT != null && environment.CDP_LOGS_PORT !== '') {
    if (!Number.isSafeInteger(explicit) || explicit <= 0 || explicit > 65_535) {
      throw new Error(`CDP_LOGS_PORT 必须是 1-65535 的整数: ${environment.CDP_LOGS_PORT}`);
    }
    return explicit;
  }

  const defaultHome = resolve(join(fallbackHome, '.cdp-control'));
  const selectedHome = resolve(cdpHome(environment, fallbackHome));
  if (selectedHome === defaultHome) return DEFAULT_LOGS_PORT;

  // FNV-1a 32-bit：仅要求同一路径稳定、不同常见路径充分分散，不用于安全边界。
  let hash = 0x811c9dc5;
  for (const char of selectedHome) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ISOLATED_LOGS_PORT_BASE + (hash % ISOLATED_LOGS_PORT_SPAN);
}

/** 连接专用/测试模式：端点不就绪时只报错，不拉起 detached 浏览器。 */
export function cdpNoAutostart(environment: CdpEnvironment = process.env): boolean {
  return environment.CDP_NO_AUTOSTART === '1';
}
