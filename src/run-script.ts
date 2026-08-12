/**
 * run-script.ts — 在 Node 侧执行"脚本体"的共享引擎(Node 侧)。
 *
 * 两种消费共用此引擎:
 *   - `run` 命令:执行任意脚本文件(副作用为主),**返回非 undefined 则打印**;
 *   - recipe(`recipe-runner.ts` 加载的站点摘要):运行 `extract(cdp, ctx)` 返回 `{lines}`。
 *
 * 信任边界:脚本/recipe 都是**作者信任的本地代码**,非沙箱;`require` 受白名单限制(仅 Node 内建),
 * recipe 靠 `cdp` 参数即可,通常不需要 require。
 */
export const BUILTIN_ALLOW = new Set(['os', 'path', 'fs', 'child_process', 'crypto', 'util', 'stream', 'url']);

export function safeRequire(id: string): unknown {
  if (BUILTIN_ALLOW.has(id)) return require(id);
  throw new Error(`脚本不可 require '${id}',仅允许 Node 内建: ${[...BUILTIN_ALLOW].join('/')}`);
}

/** 执行一段 async 脚本体(顶层 await),返回其完成值。脚本内可拿全局 `cdp` 与受白名单限制的 `require`。 */
export async function runScript(code: string, api: unknown): Promise<unknown> {
  const compiled: unknown = new Function('cdp', 'require', `return (async () => {\n${code}\n})();`);
  if (typeof compiled !== 'function') throw new Error('脚本编译结果不可执行');
  const fn = compiled as (cdp: unknown, requireBuiltin: typeof safeRequire) => Promise<unknown>;
  return await fn(api, safeRequire);
}
