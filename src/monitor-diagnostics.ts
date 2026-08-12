/** monitor 自动拉起的非阻塞错误边界；确保失败不打断主命令但始终可诊断。 */
export interface RunMonitorAutostartOptions {
  disabled?: boolean;
  reportError?: (message: string) => void;
}

export async function runMonitorAutostart(
  ensureDaemon: () => Promise<number>,
  options: RunMonitorAutostartOptions = {},
): Promise<void> {
  if (options.disabled) return;
  try {
    await ensureDaemon();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    (options.reportError ?? console.error)(`cdp-control monitor autostart failed: ${detail}`);
  }
}
