/**
 * view-format.ts — 结构视图输出的纯变换(无 DOM 依赖,可在 Node 里单测)。
 * 输入是 simplify 从 DOM 采集成的一棵内部 ViewNode 树;这里把树折叠/内联成输出行数组。
 * 与 DOM 完全解耦,逻辑从旧 scripts.js / tree.js 逐字搬移,语义不变。
 */

import { inlineable, leafText, firstTxt, isTrivialLeaf, cut } from './view-utils.ts';

/** 内部节点:simplify(DOM 采集)的产物,也是 formatView 的输入。字段与旧 view.ts 的 interface Node 一一对应。 */
export interface ViewNode {
  tag: string; isContent: boolean; text: string; inter: boolean; imgAlt: string;
  kids: ViewNode[]; size: number; hasText: boolean; leafValue?: string;
  agg?: boolean;   // 显示文本来自 innerText/grabText 兜底(聚合文本)而非直接文本节点
  shadow?: boolean; // 宿主带 shadowRoot:其下子节点来自 shadow DOM,CSS 选择器不能穿透,须用 ref 定位
  ref?: number;    // view 登记的全局引用序号(见 __cdpRefs),输出标注 [ref=i],agent 用它直接操作真实元素
  hidden?: boolean; // 纯容器 div(叶子路径上的祖父):ref 已登记进 __cdpRefs 但 view 默认不显示,info 反查可显示
  fold?: string;   // 命中折叠规则:输出一行 ▸ [ref=i] <备注>,不展开子树(但保留 ref,view <ref> 可展开)
  foldSize?: number; // 被折叠掉的子树元素数,折叠行 ▸ 备注 (N) 显示规模(view-core 折叠点算)
  hasInter?: boolean; // 自身或任一后代可交互——含交互子代的包装节点不可内联折叠,否则交互叶的 ref 被整颗吞掉
  inView?: boolean; // visible-only:自身是否落在当前视口内且可见(仅 Element 计算;包装节点不查)
  view?: boolean;   // viewport 标记:带 ref 的节点是否在当前视区内(便宜判定,rect+宽高,不查 computed style)。true → 输出 [ref=i·屏]
  state?: string[]; // 语义/原生状态(pressed/checked/expanded/selected/disabled/open;ARIA mixed 记为 name=mixed)
  inputInfo?: { type?: string; value?: string; placeholder?: string }; // INPUT/TEXTAREA/SELECT:view 显示 type/value/placeholder,让 agent 看到表单内容
  el?: Element;       // 建树时暂存真实 DOM 元素(两遍先序的遍二登记 ref 用);格式化忽略
  wantRef?: boolean;  // 遍一标记:内容/交互/折叠/shadow 宿主,遍二分配并打印 [ref=N]
  wantHidden?: boolean; // 遍一标记:纯包装含内容,遍二分配但不打印(隐藏容器,info 反查可用)
  mergeable?: boolean; // 纯文本段或命中 ignore-links 的 <a>:可与相邻文本段合并(取最后段的 ref),见 view-core
}

/** tag 输出,宿主带 shadowRoot 时追加 [shadow],提示该子树在 shadow DOM 内。 */
const tagLabel = (n: ViewNode) => n.tag + (n.shadow ? '[shadow]' : '');

/** 表单元素(INPUT/TEXTAREA/SELECT)的紧凑属性串:type/value/placeholder,空值省略。
 * 形如 `input[type=text value="搜索" placeholder="输入关键词"]`,让 agent 一眼看到表单内容而不必 eval。 */
const inputAttr = (n: ViewNode): string => {
  const i = n.inputInfo;
  if (!i) return '';
  const parts: string[] = [];
  const type = i.type?.toLowerCase();
  // INPUT 才显式标 type(默认 text 可省略;textarea/select 的 tag 已表明类型,type 无意义)
  if (n.tag === 'input' && type && type !== 'text') parts.push('type=' + type);
  // checkbox/radio 的 checked 与 type 同属 input 属性,并入这里；ref 状态区会过滤它,避免重复。
  if (n.tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    const checked = n.state?.find(s => s === 'checked' || s === 'checked=mixed');
    if (checked) parts.push(checked);
  }
  if (i.value) parts.push('value="' + i.value + '"');
  if (i.placeholder) parts.push('placeholder="' + i.placeholder + '"');
  return parts.length ? '[' + parts.join(' ') + ']' : '';
};

/** 可操作标注:状态紧跟在 ref/·屏 后、共用一个方括号。checkbox/radio 的 checked 已并入 inputAttr。 */
const refTag = (n: ViewNode) => {
  if (n.ref == null) return '';
  const inputType = n.inputInfo?.type?.toLowerCase();
  const inputChecked = n.tag === 'input' && (inputType === 'checkbox' || inputType === 'radio');
  const states = (n.state || []).filter(s => !(inputChecked && (s === 'checked' || s === 'checked=mixed')));
  return ' [ref=' + n.ref + (n.view ? '·屏' : '') + (states.length ? ' ' + states.join(' ') : '') + ']';
};

/** 标记节点是否有可视文本(自身 text/imgAlt 或任一后代),并顺带计算 hasInter(自身或任一后代可交互)。
 * 返回根节点"是否有文本"结果。hasInter 用于内联折叠判断:含交互子代的包装节点不能折叠,否则交互叶的 ref 丢失。
 *
 * fold 节点(text=''、kids=[],但有 ref+备注)视作"有内容":它本身是有效输出(▸ 行),
 * 必须把 hasText 传 true 给祖先——否则包装它的中间容器 hasText=false,被 productive filter 滤掉,
 * walk 永远到不了 fold 节点(整块从 view 消失,见知乎顶栏 fold 后 ▸ 不显示的 bug)。 */
export function markText(n: ViewNode): boolean {
  let h = !!(n.text || n.imgAlt || n.state?.length) || n.fold != null;
  let hi = !!n.inter;
  for (const k of n.kids) { if (markText(k)) h = true; if (k.hasInter) hi = true; }
  n.hasText = h;
  n.hasInter = hi;
  return h;
}

/**
 * 把已建好的 ViewNode 树折叠成带缩进的输出行数组(标签 + 引用文本)。与旧 view.js 的
 * leafish / leafLabel / inlineLabel / walk 及末尾 push(v.tag...) + for-walk 调用逐字一致。
 */
export function formatView(v: ViewNode, maxLen?: number): string[] {
  const out: string[] = [];
  const leafish = (n: ViewNode) => n.inter || n.tag === 'img';
  const leafLabel = (n: ViewNode) => {
    let l = tagLabel(n) + inputAttr(n);
    if (n.tag === 'img' && n.imgAlt) l += ' "' + cut(n.imgAlt, maxLen) + '"';
    else if (n.text) l += (n.agg ? ' ~' : ' ') + '"' + cut(n.text, maxLen) + '"';
    return l + refTag(n);
  };
  const inlineLabel = (n: ViewNode) => {
    if (n.tag === 'img' && n.imgAlt) return 'img "' + cut(n.imgAlt, maxLen) + '"';
    if (n.leafValue) {
      const v = firstTxt(n.kids);
      // leafValue 与后代首文本相同时去重(title 兜底值==子 <a> 直接文本,如 B站视频卡片),否则拼成 "X X" 重复。
      const tail = v && v !== n.leafValue ? ' ' + v : '';
      return '"' + n.leafValue + tail + '"';
    }
    return (n.agg ? '~' : '') + '"' + cut(leafText(n), maxLen) + '"';
  };

  function walk(n: ViewNode, depth: number, path: string[]) {
    // 折叠节点:输出一行带备注的折叠标识 + ref + 折叠规模,不展开子树(子树里的嵌套折叠在 view <ref> 展开时才显现)。
    if (n.fold != null) {
      out.push('  '.repeat(depth) + '▸' + refTag(n) + ' ' + n.fold + (n.shadow ? '[shadow]' : '')
        + (n.foldSize ? ' (' + n.foldSize + ')' : ''));
      return;
    }
    // 整页 view 对带 shadowRoot 的 host(depth>0 子节点,已登记 ref)只输出占位行,不展开其 shadow 子树
    // ——深入 shadow 用 `view <ref>` / `--selector-file`(局部 view 时该 host 是根 depth=0,正常展开)。
    if (depth > 0 && n.shadow && n.ref != null) {
      out.push('  '.repeat(depth) + tagLabel(n) + refTag(n));
      return;
    }
    if (n.isContent) {
      if (n.leafValue) {
        const val = firstTxt(n.kids);
        const head = path.length ? path.join(' > ') + ' > ' : '';
        // leafValue 与后代首文本相同去重,避免 "X X"(B站视频卡片 H3[title]>a)。
        const tail = val && val !== n.leafValue ? ' ' + cut(val, maxLen) : '';
        out.push('  '.repeat(depth) + head + '"' + n.leafValue + tail + '"' + refTag(n));
        return;
      }
      const hasChildText = n.kids.some(k => k.hasText);
      if (leafish(n) && n.size <= 8) {
        // 交互节点(含空 input)无文本也输出裸标签行——否则 fill 目标在 view 里不可见、ref 拿不到
        if (n.text || n.imgAlt || n.inter) out.push('  '.repeat(depth) + leafLabel(n));
        return;
      }
      if (!hasChildText) {
        if (n.tag === 'span') {
          if (n.text) {
            const head = path.length ? path.join(' > ') : '';
            out.push('  '.repeat(depth) + (head ? head + ' ' : '') + '"' + cut(n.text, maxLen) + '"' + refTag(n));
          }
          return;
        }
        const line = '  '.repeat(depth) + (path.length ? path.join(' > ') + ' > ' : '') + leafLabel(n);
        out.push(line);
        return;
      }
      // 自身直接文本 + 文本子节点并存(富文本段落,如知乎 <p>own<span>nested</span></p>):
      // 下方 productive 折叠/走子只输出子节点、把自身文本整段吞掉——先把它作为本节点文本行保住。
      if (n.text) {
        const head = path.length ? path.join(' > ') + ' ' : '';
        out.push('  '.repeat(depth) + head + '"' + cut(n.text, maxLen) + '"' + refTag(n));
      }
    }
    const kids = n.kids;
    if (!kids.length) return;
    // 无自身文本的有状态容器(如 details[open])若被单子路径折叠,也必须把 ref+状态带进路径；
    // 有自身文本的节点已在上方输出过 ref,不在路径重复。
    const pathRef = n.state?.length && !n.text ? refTag(n) : '';
    const newPath = path.concat([tagLabel(n) + pathRef]);
    // productive = 有文本且非琐碎叶,或可交互,或折叠节点,或带 ref 的 shadow host
    // (后两者 hasText/inter 都 false,需显式纳入才能 walk 到占位/▸ 输出;空壳 shadow host 不纳入就会从整页 view 消失)
    const productive = kids.filter(k => (k.hasText && !isTrivialLeaf(k)) || k.inter || !!k.state?.length
      || k.fold != null || (k.shadow && k.ref != null));
    if (productive.length === 1) { walk(productive[0], depth, newPath); return; }
    if (productive.length >= 2) {
      // 交互/带 ref/含交互子代的节点不内联折叠:必须各自成行,否则 [ref=i] 标注被吞、agent 拿不到可操作句柄。
      // 含交互子代(hasInter)也不能折叠——纯包装 DIV 内含按钮时,内联只取第一个文本,把其它交互叶的 ref 整颗吞掉(如知乎评论动作行)。
      if (productive.every(k => inlineable(k) && !k.inter && !k.hasInter && k.ref == null)) {
        const items = productive.map(inlineLabel).join(' ');
        out.push('  '.repeat(depth) + (newPath.length ? newPath.join(' > ') + ' ' : '') + items);
        return;
      }
      if (newPath.length) out.push('  '.repeat(depth) + newPath.join(' > '));
      for (const k of productive) walk(k, depth + 1, []);
    }
  }

  out.push(tagLabel(v) + (v.text ? ' "' + cut(v.text, maxLen) + '"' : '') + refTag(v));
  for (const k of v.kids) walk(k, 1, []);
  return out;
}
