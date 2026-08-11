/**
 * view-format.test.ts — 结构树纯变换(formatView / markText / ViewNode)的单元测试
 * (Node 内置 node:test,零依赖)。直接 import src/inject/lib/view-format,锁定折叠/内联行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markText, formatView, type ViewNode } from '../src/inject/lib/view-format.ts';
import { leafText } from '../src/inject/lib/view-utils.ts';

/** 构造 ViewNode 的便捷 helper:size 由 markText 前手动填,hasText 由 markText 重算。 */
function mk(over: Partial<ViewNode>): ViewNode {
  return { tag: 'div', isContent: false, text: '', inter: false, imgAlt: '', kids: [], size: 1, hasText: false, ...over };
}

test('formatView: 纯包装节点折叠(productive.length===1 时递归,输出不含中间标签)', () => {
  const btn = mk({ tag: 'button', isContent: true, text: '点击', inter: true, size: 1 });
  const wrap = mk({ tag: 'div', isContent: false, size: 2, kids: [btn] });
  const root = mk({ tag: 'html', isContent: false, size: 3, kids: [wrap] });
  markText(root);
  // wrapper div 被折叠:不出现 "div" 行,只有 button 一行
  assert.deepEqual(formatView(root), ['html', '  button "点击"']);
});

test('formatView: 多个短文本后代被内联成一行', () => {
  const s1 = mk({ tag: 'span', isContent: true, text: '首页', size: 1 });
  const s2 = mk({ tag: 'span', isContent: true, text: '发现', size: 1 });
  const s3 = mk({ tag: 'span', isContent: true, text: '我的', size: 1 });
  const nav = mk({ tag: 'nav', isContent: false, size: 4, kids: [s1, s2, s3] });
  const root = mk({ tag: 'div', isContent: false, size: 5, kids: [nav] });
  markText(root);
  // 三个短文本后代全部 inlineable,合并成 "nav 首页 发现 我的" 一行
  assert.deepEqual(formatView(root), ['div', '  nav "首页" "发现" "我的"']);
});

test('formatView: 两个以上非内联 productive 后代各自成行', () => {
  const long1 = '核心'.repeat(13); // 26 字符,>24 不可内联
  const long2 = '要点'.repeat(13); // 26 字符
  const p1 = mk({ tag: 'p', isContent: true, text: long1, size: 1 });
  const h2 = mk({ tag: 'h2', isContent: true, text: long2, size: 1 });
  const sec = mk({ tag: 'section', isContent: false, size: 3, kids: [p1, h2] });
  const root = mk({ tag: 'div', isContent: false, size: 4, kids: [sec] });
  markText(root);
  // section 作为分支标签单独一行,两个长后代各自缩进成行
  assert.deepEqual(formatView(root), [
    'div',
    '  section',
    '    p "' + long1 + '"',
    '    h2 "' + long2 + '"',
  ]);
});

test('formatView: span 单文本行(!hasChildText && span && text → "text")', () => {
  const span = mk({ tag: 'span', isContent: true, text: '标题', size: 1 });
  const root = mk({ tag: 'div', isContent: false, size: 2, kids: [span] });
  markText(root);
  // span 无子文本,走引号裸文案行(无标签)
  assert.deepEqual(formatView(root), ['div', '  "标题"']);
});

test('formatView: leafValue 节点输出 "leafValue 后代首文本" 行', () => {
  const txt = mk({ tag: 'span', isContent: true, text: '22.9万', size: 1 });
  const item = mk({ tag: 'li', isContent: true, leafValue: '点赞', size: 2, kids: [txt] });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [item] });
  markText(root);
  // leafValue 项拼上后代首文本
  assert.deepEqual(formatView(root), ['div', '  "点赞 22.9万"']);
});

test('formatView: leafish 叶(inter 或 img)输出 leafLabel 行', () => {
  const img = mk({ tag: 'img', isContent: true, imgAlt: '封面', size: 1 });
  const btn = mk({ tag: 'button', isContent: true, text: '登录', inter: true, size: 1 });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [img, btn] });
  markText(root);
  // img 叶:img "封面";inter 叶 button:button "登录"
  assert.deepEqual(formatView(root), ['div', '  img "封面"', '  button "登录"']);
});

test('formatView: 自身直接文本 + 文本子节点并存时,ownText 不丢(富文本段落)', () => {
  // 模拟知乎富文本段落 <p>own<span>nested</span></p>:p 既有自身文本又有文本子节点。
  const span = mk({ tag: 'span', isContent: true, text: '你的大脑其实已经在腹腔了。', size: 1 });
  const p = mk({ tag: 'p', isContent: true, text: '肠子才是动物进化路中最先出现的大脑，', size: 2, kids: [span] });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [p] });
  markText(root);
  // p 的 ownText 必须出现,不能只显示子 span(否则段落前半截整段丢失)
  assert.deepEqual(formatView(root), ['div', '  "肠子才是动物进化路中最先出现的大脑，"', '  p "你的大脑其实已经在腹腔了。"']);
});

test('markText: 自身文本或后代文本都置 hasText=true', () => {
  const child = mk({ tag: 'span', isContent: true, text: '子', size: 1 });
  const root = mk({ tag: 'div', isContent: false, size: 2, kids: [child] });
  assert.equal(markText(root), true);
  assert.equal(root.hasText, true);
  assert.equal(child.hasText, true);
  const empty = mk({ tag: 'div', isContent: false, size: 1 });
  assert.equal(markText(empty), false);
  assert.equal(empty.hasText, false);
});

test('formatView: 聚合文本节点(agg)输出 ~ 前缀,字面文本不加', () => {
  const agg = mk({ tag: 'a', isContent: true, text: '首页', inter: true, agg: true, size: 1 });
  const lit = mk({ tag: 'a', isContent: true, text: '下载', inter: true, size: 1 });
  const root = mk({ tag: 'nav', isContent: false, size: 3, kids: [agg, lit] });
  markText(root);
  assert.deepEqual(formatView(root), ['nav', '  a ~"首页"', '  a "下载"']);
});

test('formatView: 登记过 ref 的叶子输出 [ref=i] 标注', () => {
  const btn = mk({ tag: 'button', isContent: true, text: '登录', inter: true, size: 1, ref: 3 });
  const p = mk({ tag: 'p', isContent: true, text: '评论文本', size: 1, ref: 7 });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [btn, p] });
  markText(root);
  // inter 叶 + 文本叶各自带 ref 标注;纯包装 div 无 ref 不标
  assert.deepEqual(formatView(root), ['div', '  button "登录" [ref=3]', '  p "评论文本" [ref=7]']);
});

test('formatView: 根节点带 ref 也输出 [ref=i](反馈树根常是新增元素,ref 不能丢)', () => {
  const root = mk({ tag: 'div', isContent: true, text: '新增评论 1', size: 1, ref: 5, view: true });
  markText(root);
  assert.deepEqual(formatView(root), ['div "新增评论 1" [ref=5·屏]']);
});

test('formatView: view=true 的带 ref 节点标 [ref=i·屏],无 view 只标 [ref=i]', () => {
  const onScreen = mk({ tag: 'button', isContent: true, text: '在屏', inter: true, size: 1, ref: 3, view: true });
  const offScreen = mk({ tag: 'button', isContent: true, text: '离屏', inter: true, size: 1, ref: 4, view: false });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [onScreen, offScreen] });
  markText(root);
  assert.deepEqual(formatView(root), ['div', '  button "在屏" [ref=3·屏]', '  button "离屏" [ref=4]']);
});

test('formatView: 语义状态跟在 ref/·屏 后且无状态时零额外输出', () => {
  const pressed = mk({ tag: 'button', isContent: true, text: '赞', inter: true, size: 1, ref: 5, view: true, state: ['pressed'] });
  const expanded = mk({ tag: 'button', isContent: true, text: '展开', inter: true, size: 1, ref: 9, state: ['expanded'] });
  const disabled = mk({ tag: 'button', isContent: true, text: '', inter: true, size: 1, ref: 3, state: ['disabled'] });
  const plain = mk({ tag: 'button', isContent: true, text: '取消', inter: true, size: 1, ref: 10 });
  const root = mk({ tag: 'div', isContent: false, size: 5, kids: [pressed, expanded, disabled, plain] });
  markText(root);
  assert.deepEqual(formatView(root), [
    'div',
    '  button "赞" [ref=5·屏 pressed]',
    '  button "展开" [ref=9 expanded]',
    '  button [ref=3 disabled]',
    '  button "取消" [ref=10]',
  ]);
});

test('formatView: checkbox/radio 的 checked 并入 inputAttr,不在 ref 内重复', () => {
  const checkbox = mk({
    tag: 'input', isContent: true, inter: true, size: 1, ref: 7,
    inputInfo: { type: 'checkbox' }, state: ['checked', 'disabled'],
  });
  const radio = mk({
    tag: 'input', isContent: true, inter: true, size: 1, ref: 8,
    inputInfo: { type: 'radio' }, state: ['checked=mixed'],
  });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [checkbox, radio] });
  markText(root);
  assert.deepEqual(formatView(root), [
    'div',
    '  input[type=checkbox checked] [ref=7 disabled]',
    '  input[type=radio checked=mixed] [ref=8]',
  ]);
});

test('formatView: 无文本的原生状态容器仍输出状态行(details.open)', () => {
  const details = mk({ tag: 'details', isContent: true, size: 1, ref: 12, state: ['open'] });
  const wrap = mk({ tag: 'section', isContent: false, size: 2, kids: [details] });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [wrap] });
  markText(root);
  assert.deepEqual(formatView(root), ['div', '  section > details [ref=12 open]']);
});

test('formatView: 无 ref 节点不标 [ref=i](不回归)', () => {
  const a = mk({ tag: 'a', isContent: true, text: '首页', inter: true, size: 1 });
  const root = mk({ tag: 'nav', isContent: false, size: 2, kids: [a] });
  markText(root);
  assert.deepEqual(formatView(root), ['nav', '  a "首页"']);
});

test('formatView: leafValue 与首个子文本相同时去重(不输出 "X X")', () => {
  // 复现 B站视频卡片标题 bug:<h3 title="极寒末日..."><a>极寒末日...</a></h3>
  // leafValue 来自 title 兜底,子 <a> 直接文本与之相同,旧逻辑拼成 "极寒末日... 极寒末日..." 重复两遍。
  const txt = mk({ tag: 'a', isContent: true, text: '极寒末日96分钟无删减合集', inter: true, size: 1 });
  const item = mk({ tag: 'li', isContent: true, leafValue: '极寒末日96分钟无删减合集', size: 2, kids: [txt] });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [item] });
  markText(root);
  // leafValue 与后代首文本相同 → 只输出一次
  assert.deepEqual(formatView(root), ['div', '  "极寒末日96分钟无删减合集"']);
});

test('formatView: leafValue 与 span 文本行也带 ref 标注', () => {
  const item = mk({ tag: 'li', isContent: true, leafValue: '点赞', size: 2, ref: 5, kids: [mk({ tag: 'span', isContent: true, text: '22.9万', size: 1 })] });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [item] });
  markText(root);
  assert.deepEqual(formatView(root), ['div', '  "点赞 22.9万" [ref=5]']);
});

test('formatView: 交互/带 ref 节点不内联折叠,各自成行且标注可见', () => {
  // 纯文本 span 可与短文本兄弟内联;但交互 button(带 ref)必须单独成行,否则 [ref=i] 被吞。
  const t1 = mk({ tag: 'span', isContent: true, text: '外部文本', size: 1 });
  const btn = mk({ tag: 'button', isContent: true, text: 'shadow按钮', inter: true, size: 1, ref: 4 });
  const wrap = mk({ tag: 'div', isContent: false, size: 3, kids: [t1, btn] });
  const root = mk({ tag: 'html', isContent: false, size: 4, kids: [wrap] });
  markText(root);
  // 按钮不并入文本行,独立成行带 [ref=4];span 也被拆到各自行
  assert.deepEqual(formatView(root), ['html', '  div', '    "外部文本"', '    button "shadow按钮" [ref=4]']);
});

test('formatView: 含交互子代的纯包装节点不可内联,交互叶各自出 [ref](知乎评论动作行场景)', () => {
  // 复现知乎评论动作行 bug:css-18opwoy 是纯包装 DIV,子代是"回复"+点赞两个按钮。
  // 旧逻辑只看包装自身(非交互、无 ref)就内联折叠,leafText 只取第一个文本"回复",点赞按钮的 "85" 和 ref 被整颗吞掉。
  const reply = mk({ tag: 'button', isContent: true, text: '回复', inter: true, size: 1, ref: 5 });
  const like = mk({ tag: 'button', isContent: true, text: '85', inter: true, size: 1, ref: 6 });
  const actionRow = mk({ tag: 'div', isContent: false, size: 3, kids: [reply, like] }); // 纯包装,含交互子代
  const timeText = mk({ tag: 'span', isContent: true, text: '18 小时前', size: 1 });
  const meta = mk({ tag: 'div', isContent: false, size: 5, kids: [timeText, actionRow] });
  const root = mk({ tag: 'html', isContent: false, size: 6, kids: [meta] });
  markText(root);
  // actionRow 因含交互子代(hasInter)不可内联:meta 不折叠成 "18 小时前" "回复",两个按钮各自成行带 ref
  assert.deepEqual(formatView(root), [
    'html',
    '  div',
    '    "18 小时前"',
    '    div',
    '      button "回复" [ref=5]',
    '      button "85" [ref=6]',
  ]);
});

test('formatView: 空壳 shadow host(带 ref)输出占位行,不展开其 shadow 子树(bili-comments 场景)', () => {
  // 复现 B站视频页:整页 view 看不到评论区。bili-comments 是 custom element,自身非交互、无 light 文本,
  // 首屏 shadowRoot 还是空壳。旧逻辑下 host 不登记 ref + productive 过滤后整块消失。
  // 修法:带 ref 的 shadow host 在整页 view 里输出占位行,agent 据此用 view <ref> 展开。
  const shadowKid = mk({ tag: 'div', isContent: true, text: 'shadow 内部不应出现', size: 1 });
  const comments = mk({ tag: 'bili-comments', isContent: true, text: '', inter: false, shadow: true, ref: 9, size: 2, kids: [shadowKid] });
  const root = mk({ tag: 'body', isContent: false, size: 3, kids: [comments] });
  markText(root);
  // 只输出占位行 bili-comments[shadow] [ref=9],其下的 shadow 内容不展开
  assert.deepEqual(formatView(root), ['body', '  bili-comments[shadow] [ref=9]']);
});

test('formatView: 有 light 文本的 shadow host 也只占位(整页 view 不深入 shadow)', () => {
  // 即便 host 有 light 文本或 shadow 子树有内容,整页 view 仍只占位——深入用 view <ref>。
  const inner = mk({ tag: 'span', isContent: true, text: '评论条目', size: 1 });
  const host = mk({ tag: 'x-list', isContent: true, text: '评论区', inter: false, shadow: true, ref: 4, size: 2, kids: [inner] });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [host] });
  markText(root);
  assert.deepEqual(formatView(root), ['div', '  x-list[shadow] [ref=4]']);
});

test('formatView: shadow host 命中 fold 规则时走 fold 占位(fold 优先于 shadow 占位)', () => {
  // 折叠优先级:命中 fold 的 host 仍输出 ▸ 折叠行(带 [shadow] 标记),不走 shadow 占位。
  const inner = mk({ tag: 'div', isContent: true, text: '内容', size: 1 });
  const host = mk({ tag: 'x-foo', isContent: true, shadow: true, ref: 2, fold: '折叠区', size: 2, kids: [inner] });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [host] });
  markText(root);
  assert.deepEqual(formatView(root), ['div', '  ▸ [ref=2] 折叠区[shadow]']);
});

test('formatView: 根是 shadow host 时不占位(view <ref> 展开场景,正常输出子树)', () => {
  // view <ref> 把 shadow host 当根(depth=0),应正常展开其 shadow 子树,不走占位 return。
  const inner = mk({ tag: 'span', isContent: true, text: '评论 1', size: 1, ref: 1 });
  const root = mk({ tag: 'bili-comments', isContent: true, shadow: true, ref: 0, size: 2, kids: [inner] });
  markText(root);
  // 根行带 [shadow] 标记 + [ref=0];子节点 span 正常成行
  assert.deepEqual(formatView(root), ['bili-comments[shadow] [ref=0]', '  "评论 1" [ref=1]']);
});

test('formatView: fold 节点被多层纯包装容器包裹仍输出 ▸ 占位(知乎顶栏 bug 回归)', () => {
  // 真实场景:知乎顶栏 header.AppHeader 在 body>div#root>div>div.css>header(4 层包装)。
  // fold 节点 text=''、kids=[],若 markText 不把它视作"有内容",则包装链 hasText=false,
  // 被 productive filter 滤掉,walk 永远到不了 fold 节点 → 顶栏整块消失、无 ▸ 占位。
  // 此测试锁定:fold 节点哪怕被多层 isContent=false 的纯包装 div 包裹,也要输出 ▸。
  const foldNode = mk({ tag: 'header', isContent: true, text: '', ref: 1, fold: '知乎顶栏', size: 1, kids: [] });
  const wrap3 = mk({ tag: 'div', isContent: false, size: 2, kids: [foldNode] });   // 模拟 div.css-s8xum0
  const wrap2 = mk({ tag: 'div', isContent: false, size: 3, kids: [wrap3] });       // 模拟 div
  const wrap1 = mk({ tag: 'div', isContent: false, size: 4, kids: [wrap2] });       // 模拟 div#root
  const root = mk({ tag: 'body', isContent: false, size: 5, kids: [wrap1] });
  markText(root);
  // 期望:多层包装被折叠掉,只剩 ▸ 占位行(包装 div 不输出,因为 productive.length===1 递归 walk)
  assert.deepEqual(formatView(root), ['body', '  ▸ [ref=1] 知乎顶栏']);
});

test('markText: fold 节点(空文本空 kids)置 hasText=true 并传播给所有祖先', () => {
  // 锁定 markText 对 fold 节点的处理:fold 节点本身 hasText=true,且把这个 true 传给父链。
  // 若不传,父被 isTrivialLeaf 误判 + productive 滤掉,fold 占位消失。
  const foldNode = mk({ tag: 'header', isContent: true, text: '', ref: 0, fold: '区', size: 1, kids: [] });
  const wrap = mk({ tag: 'div', isContent: false, size: 2, kids: [foldNode] });
  const root = mk({ tag: 'body', isContent: false, size: 3, kids: [wrap] });
  markText(root);
  assert.equal(foldNode.hasText, true, 'fold 节点自身 hasText 应为 true');
  assert.equal(wrap.hasText, true, '直接父 hasText 应被 fold 子代传播为 true');
  assert.equal(root.hasText, true, '祖先 hasText 应被传播为 true');
});

test('leafText: fold 节点返回其备注(让包装它的容器不被 isTrivialLeaf 误判)', () => {
  // leafText 对 fold 节点应返回 fold 备注,否则纯包装容器 leafText='' → isTrivialLeaf=true
  // → productive filter (k.hasText && !isTrivialLeaf) 失败 → fold 消失。
  const foldNode = mk({ tag: 'header', fold: '顶栏', text: '', kids: [] });
  assert.equal(leafText(foldNode), '顶栏');
  // 包装容器通过 fold 子节点取到备注
  const wrap = mk({ tag: 'div', kids: [foldNode] });
  assert.equal(leafText(wrap), '顶栏');
});

test('formatView: 折叠节点带 foldSize 输出 ▸ 备注 (N)', () => {
  const folded = mk({ tag: 'header', isContent: true, text: '', ref: 1, fold: '顶栏', foldSize: 23, size: 1, kids: [] });
  const root = mk({ tag: 'body', isContent: false, size: 2, kids: [folded] });
  markText(root);
  assert.deepEqual(formatView(root), ['body', '  ▸ [ref=1] 顶栏 (23)']);
});

test('formatView: 折叠节点无 foldSize 不带括号(回归)', () => {
  const folded = mk({ tag: 'footer', isContent: true, text: '', ref: 2, fold: '页脚', size: 1, kids: [] });
  const root = mk({ tag: 'body', isContent: false, size: 2, kids: [folded] });
  markText(root);
  assert.deepEqual(formatView(root), ['body', '  ▸ [ref=2] 页脚']);
});

test('formatView: 缺省不截断,长文本完整输出', () => {
  const long = '制度性硬化'.repeat(20); // 100 字符,旧逻辑会截 60
  const p = mk({ tag: 'p', isContent: true, text: long, size: 1, ref: 5 });
  const root = mk({ tag: 'div', isContent: false, size: 2, kids: [p] });
  markText(root);
  assert.deepEqual(formatView(root), ['div', '  p "' + long + '" [ref=5]']);
});

test('formatView: --max-len 截断超长文本并补省略号,短文本不截', () => {
  const long = '制度性硬化'.repeat(20); // 100 字符;slice(0,10) 取前 10 字 = 两段 "制度性硬化"
  const short = '首页';
  const p = mk({ tag: 'p', isContent: true, text: long, size: 1, ref: 5 });
  const a = mk({ tag: 'a', isContent: true, text: short, inter: true, size: 1, ref: 6 });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [p, a] });
  markText(root);
  assert.deepEqual(formatView(root, 10), ['div', '  p "制度性硬化制度性硬化…" [ref=5]', '  a "首页" [ref=6]']);
});
