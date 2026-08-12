/**
 * genSel.ts — 为 DOM 元素生成唯一 CSS 选择器(稳定锚点优先,位置链只兜底)。
 * 被 click/fill/focus/hover/locate/fold/get-focus 复用,打包打进各入口。
 * 仅覆盖 light DOM(shadow 内元素的 parentElement 在 shadow 边界为 null,路径断在 host 锚定)。
 *
 * 锚点优先级(命中即停、向上爬到最近稳定祖先):
 *   id > data-testid/test/cy/qa > 其它语义 data-* > aria-label/role > 唯一 class > nth-of-type 链
 * 参考现实:uBlock 屏蔽 B站顶栏只用 `###biliMainHeader`(id)——真实站点区域容器常有稳定锚点。
 */

/** 测试锚点属性(极稳,优先于其它 data-*)。 */
const TEST_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
/** 语义化 data-* 属性名(优先于泛化 data-*)。 */
const SEMANTIC_DATA_ATTRS = ['data-role', 'data-type', 'data-component', 'data-name'];

/** CSS 选择器属性值转义(属性值用引号包裹,只需转义引号/反斜线/换行)。 */
function escAttr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 全文档内该 selector 是否唯一命中(运行时 document 可用)。 */
function isUnique(sel: string): boolean {
  try {
    return (document as any).querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
}

/** 全文档内该 selector 是否命中给定元素自己(精确,不漂到祖先)。 */
function matchesEl(el: Element, sel: string): boolean {
  try {
    return (document as any).querySelector(sel) === el;
  } catch {
    return false;
  }
}

/**
 * 尝试为单个元素生成"自锚定"selector(不依赖祖先):
 *   - id 唯一 → #id
 *   - 测试锚点属性(data-testid 等)全文档唯一 → [data-testid="..."]
 *   - 语义/其它 data-* 全文档唯一 → [data-role="..."]
 *   - aria-label 全文档唯一 → [aria-label="..."]
 *   - 某 class 全文档唯一 → .cls
 * 命中即返回 selector;否则 null(调用方决定向上爬)。
 */
function selfAnchor(el: Element): string | null {
  // 1. id(文档唯一且命中 el 自己 → #id;重复 id 罕见但防御一下)
  const id = el.id;
  if (id) {
    const sel = '#' + CSS.escape(id);
    if (matchesEl(el, sel)) return sel;
  }

  // 2. 测试锚点属性(语义稳,优先于泛化 data-*)
  for (const attr of TEST_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) {
      const sel = `${el.tagName.toLowerCase()}[${attr}="${escAttr(v)}"]`;
      if (isUnique(sel)) return sel;
    }
  }

  // 3. 语义 data-* 优先,再扫其它非空 data-*
  const attrs = (el as any).attributes;
  if (attrs) {
    const dataEntries: { name: string; value: string }[] = [];
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.name.startsWith('data-') && a.value) dataEntries.push({ name: a.name, value: a.value });
    }
    dataEntries.sort((a, b) => {
      const ai = SEMANTIC_DATA_ATTRS.indexOf(a.name);
      const bi = SEMANTIC_DATA_ATTRS.indexOf(b.name);
      // 语义名排前(找不到的当 Infinity);其余按名字字典序稳定排
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.name.localeCompare(b.name);
    });
    for (const { name, value } of dataEntries) {
      const sel = `${el.tagName.toLowerCase()}[${name}="${escAttr(value)}"]`;
      if (isUnique(sel)) return sel;
    }
  }

  // 4. aria-label(无障碍标签,区域容器常带且稳)
  const label = el.getAttribute('aria-label');
  if (label) {
    const sel = `${el.tagName.toLowerCase()}[aria-label="${escAttr(label)}"]`;
    if (isUnique(sel)) return sel;
  }

  // 5. 唯一 class(某 class 全文档仅一个元素带)
  const classList = (el as any).classList;
  if (classList && classList.length) {
    for (const cls of classList) {
      const sel = '.' + CSS.escape(cls);
      if (isUnique(sel)) return sel;
    }
  }

  return null;
}

/**
 * 从 ancestor 向下到 el 的 :nth-of-type 位置链(不含 ancestor 本身)。
 * 每段 tag:nth-of-type(n)(同名兄弟仅一个时不带序号)。
 */
function descentChain(ancestor: Element, el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== ancestor) {
    const parent: Element | null = cur.parentElement;
    if (!parent) break; // shadow 边界,parentElement 断
    let part = cur.tagName.toLowerCase();
    const sibs = Array.from(parent.children).filter(c => c.tagName === cur!.tagName);
    if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}

/**
 * 生成唯一 CSS 选择器;无效元素返回 null。
 * 优先用稳定语义锚点(id / data-* / aria-label / 唯一 class),都没有才退回 nth-of-type 位置链。
 */
export function genSel(el: Element | null): string | null {
  if (!el) return null;

  // 元素自身即可自锚定 → 直接返回(最短最稳)
  const self = selfAnchor(el);
  if (self) return self;

  // 否则向上找最近的"稳定祖先"(能自锚定的),在其下补位置链到 el
  let cur: Element | null = el.parentElement;
  while (cur && cur.nodeType === 1) {
    const anchor = selfAnchor(cur);
    if (anchor) {
      const chain = descentChain(cur, el);
      const sel = chain ? `${anchor} > ${chain}` : anchor;
      // 锚点祖先下补链后,确保仍精确命中 el 自己(不漂到祖先)
      if (matchesEl(el, sel)) return sel;
      // 罕见:锚点祖先 + 链不够精确,继续向上找更强锚点
    }
    cur = cur.parentElement;
  }

  // 兜底:没有任何锚点,纯 nth-of-type 位置链(从 el 爬到 documentElement)
  // 复用 descentChain 思路:把根(html)当"虚拟祖先"——html 无 parentElement,链从 body 段开始
  const parts: string[] = [];
  cur = el;
  while (cur && cur.nodeType === 1) {
    const parent: Element | null = cur.parentElement;
    if (parent) {
      let part = cur.tagName.toLowerCase();
      const sibs = Array.from(parent.children).filter(c => c.tagName === cur!.tagName);
      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      parts.unshift(part);
    } else {
      // 到达根(html 无父):html 是文档唯一根,直接作首段
      parts.unshift(cur.tagName.toLowerCase());
    }
    cur = parent;
  }
  return parts.join(' > ');
}
