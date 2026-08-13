/** monitor daemon 绑定后的启动编排；副作用由调用方注入，便于验证对外可见与 PID 发布顺序。 */
export interface BoundDaemonStartup {
  bind(): Promise<void>;
  publishPid(): void;
  rollbackBind(): Promise<void>;
  /** 仅撤销本轮刚发布的 PID authority；调用方负责 owner-safe 删除。 */
  rollbackPid?(): void;
  syncInitialTargets(): Promise<void>;
}

export async function initializeBoundDaemon(startup: BoundDaemonStartup): Promise<void> {
  await startup.bind();
  try {
    startup.publishPid();
  } catch (cause) {
    try {
      await startup.rollbackBind();
    } catch {}
    throw cause;
  }
  try {
    await startup.syncInitialTargets();
  } catch (cause) {
    try {
      startup.rollbackPid?.();
    } catch {}
    try {
      await startup.rollbackBind();
    } catch {}
    throw cause;
  }
}
