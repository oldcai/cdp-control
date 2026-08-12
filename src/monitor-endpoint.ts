/** monitor daemon 端点快照；确保父进程判定 identity 与子进程实际连接参数完全一致。 */
import type { DaemonIdentity } from './monitor-health.ts';
import type { CdpEnvironment } from './paths.ts';

export function daemonChildEnvironment(
  environment: CdpEnvironment,
  identity: DaemonIdentity,
  logsPort: number,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    CDP_HOME: identity.home,
    CDP_HOST: identity.cdpHost,
    CDP_PORT: identity.cdpPort,
    CDP_LOGS_PORT: String(logsPort),
  };
}
