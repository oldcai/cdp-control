/** monitor daemon 的纯身份/健康协议；无副作用，便于隔离测试。 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cdpHome, type CdpEnvironment } from './paths.ts';

export interface DaemonIdentity {
  home: string;
  cdpHost: string;
  cdpPort: string;
}

interface DaemonHealth {
  ok: true;
  identity: DaemonIdentity;
  targets: number;
}

export function daemonIdentity(
  environment: CdpEnvironment = process.env,
  fallbackHome: string = homedir(),
  cdpHost: string,
  cdpPort: string | number,
): DaemonIdentity {
  return {
    home: resolve(cdpHome(environment, fallbackHome)),
    cdpHost,
    cdpPort: String(cdpPort),
  };
}

export function daemonPidFilePath(environment: CdpEnvironment = process.env, fallbackHome: string = homedir()): string {
  return join(resolve(cdpHome(environment, fallbackHome)), 'cdp-listen.pid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDaemonIdentity(value: unknown): value is DaemonIdentity {
  return (
    isRecord(value) &&
    typeof value.home === 'string' &&
    typeof value.cdpHost === 'string' &&
    typeof value.cdpPort === 'string'
  );
}

function isDaemonHealth(value: unknown): value is DaemonHealth {
  return isRecord(value) && value.ok === true && typeof value.targets === 'number' && isDaemonIdentity(value.identity);
}

export function sameDaemonIdentity(actual: DaemonIdentity, expected: DaemonIdentity): boolean {
  return actual.home === expected.home && actual.cdpHost === expected.cdpHost && actual.cdpPort === expected.cdpPort;
}

/** 旧版只有 `{ok:true}` 的 health 必须 fail closed，不能误认成当前 home/endpoint 的 daemon。 */
export async function daemonHealthy(
  port: number,
  expected: DaemonIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`);
    if (!response.ok) return false;
    const health: unknown = await response.json();
    return isDaemonHealth(health) && sameDaemonIdentity(health.identity, expected);
  } catch {
    return false;
  }
}
