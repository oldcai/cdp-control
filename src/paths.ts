/**
 * paths.ts — cdp-control 数据 home 定位(最底层,不依赖其它项目模块)。
 *
 * 运行时默认使用 ~/.cdp-control;CDP_HOME 为测试和多实例提供受支持的
 * 整体隔离入口。env/home 可注入,便于跨平台纯函数单测。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CdpEnvironment {
  readonly [name: string]: string | undefined;
}

export function cdpHome(environment: CdpEnvironment = process.env, fallbackHome: string = homedir()): string {
  return environment.CDP_HOME || join(fallbackHome, '.cdp-control');
}

/** 连接专用/测试模式：端点不就绪时只报错，不拉起 detached 浏览器。 */
export function cdpNoAutostart(environment: CdpEnvironment = process.env): boolean {
  return environment.CDP_NO_AUTOSTART === '1';
}
