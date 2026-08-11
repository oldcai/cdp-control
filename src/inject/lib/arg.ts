/**
 * arg.ts — 注入脚本的参数类型契约。
 *
 * 每个注入入口用自由标识符 `__CDP_ARG__`(TS 里 `declare const`)读取参数;
 * Node 侧注入前拼一行 `var __CDP_ARG__ = <json>;`(见 src/inject-loader.ts)。
 * 各入口按需声明自己的参数形状。
 */

/** click/focus/hover:按 selector 或 ref(真实元素引用,穿透 shadow)定位并操作;ancestor 可选按 ref 定位后爬父。 */
export interface FindArgs { sel?: string; ref?: number; ancestor?: number }

/** fill:按 selector 或 ref 填值;ancestor 可选按 ref 定位后爬父。 */
export interface FillArgs { sel?: string; ref?: number; ancestor?: number; value: string }

/** view:按 selector / ref 求建视图根元素(注入侧 findRoot + refElement/climbAncestors 解析,含 shadow 穿透)。
 * 锚点互斥:ref 优先,其次 selector;缺省 body。ancestor 为统一爬父修饰符(对任一锚点生效)。
 * folds:当前 hostname 命中的持久折叠规则(Node 侧 folds.ts 过滤后传入),buildView 遇匹配 selector 折叠成一行。
 * scrollToLoad:启用滚动加载。无 scrollPages/scrollTo 时为默认 ±1 屏回弹;给 scrollPages 改为循环向下滚 N 屏
 *   (边滚边检测 scrollHeight 增长,连续 2 次不增长提前停);给 scrollTo 改为先滚到该 selector 元素再建视图
 *   (B站评论区等容器)。两者可并用(先滚到元素,再循环滚 N 屏)。 */
export interface FoldItem { selector: string; note: string }
export interface ViewArgs {
  selector?: string; visibleOnly?: boolean; ref?: number; ancestor?: number;
  scrollToLoad?: boolean; scrollPages?: number; scrollTo?: string;
  scrollWait?: number; folds?: FoldItem[]; ignoreLinks?: string[];
  maxLen?: number; // 文本截断阈值(字符数);缺省不截断(view 全量)
}

/** locate:按 view 的 ref 序号反查稳定 CSS selector,可选 --ancestor 向上爬 N 层。 */
export interface LocateArgs { ref: number; ancestor?: number }

/** find 命令:按文本或 selector 找元素,登记 ref 返回。text/selector 二选一;
 * ancestor 命中后爬父到容器;all 返回全部命中而非首个。 */
export interface FindCmdArgs { text?: string; selector?: string; ancestor?: number; all?: boolean }

/** info:列目标元素(爬 ancestor 后)从 html 到自身的祖先链,每层紧凑显示 tag/id/class/语义 data-* /aria/role。
 * 供 agent 挑稳定锚点自己写 fold add 这种 uBlock 式短规则(如 #biliMainHeader)。 */
export interface InfoArgs { ref: number; ancestor?: number }

/** article:按 ref 提取子树为格式友好的 Markdown 文章(保序、不截断,穿透 shadow)。ancestor 可选按 ref 定位后爬父。
 * ignoreLinks:持久链接黑名单模式数组(Node 侧 ignore-links.ts 读后传入),命中只留文本、去 URL。 */
export interface ArticleArgs { ref: number; ancestor?: number; ignoreLinks?: string[] }

/** read-content:展开再读的容器定位——按 container selector 重查正文容器,统一复用或追加登记进 __cdpRefs
 * (展开重渲染替换元素,旧 ref 失效),返回 ref。纯同步(点击/等待由 Node 侧分开编排)。 */
export interface ReadContentArgs { container: string }

/** read:控制台日志过滤(level 数组;since 毫秒时间戳)。 */
export interface ReadArgs { level?: string[]; since?: number }

/** fold:会话级临时折叠(ref/ancestor/note 临时折叠;list 列出临时;clear 清空临时)。持久规则(--save)由 Node 侧处理,不经此入口。 */
export interface FoldArgs { ref?: number; ancestor?: number; note?: string; list?: boolean; clear?: boolean }
