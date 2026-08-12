/** detached monitor child 的 spawn/error 握手；成功创建前绝不 unref。 */
import { spawn } from 'node:child_process';

export function spawnDetachedDaemon(executable: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        detached: true,
        env: environment,
        stdio: 'ignore',
      });
    } catch (cause) {
      reject(
        new Error(`启动 monitor daemon 失败: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }),
      );
      return;
    }

    const onError = (cause: Error): void => {
      child.off('spawn', onSpawn);
      reject(new Error(`启动 monitor daemon 失败: ${cause.message}`, { cause }));
    };
    const onSpawn = (): void => {
      child.off('error', onError);
      child.unref();
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}
