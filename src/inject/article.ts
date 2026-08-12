/**
 * article.ts — 文章提取注入入口:以 ref 元素为根,沿 childNodes 保序递归遍历,
 * 按 tag 语义发成格式友好的 Markdown(不截断)。
 *
 * 为何不用 buildView:buildView 的 simplify 把元素自身直接文本合并成 blob、内联子元素
 * (<a>/<b>)拆成独立子节点,丢失句子内顺序(<p>前 <a>链</a> 后</p> 变 "前后"+链接)。
 * 文章对顺序敏感,故专用遍历直接沿 childNodes 保序走,Text 节点与子元素天然交错。
 */
import { setResult } from './lib/result';
import { refElement, climbAncestors } from './lib/find-root';
import { notFoundResult, type OperableArg } from './lib/find';
import { elLabel, ownElText } from './lib/view-core';
import { linkIgnored } from './lib/ignore-links';
import { decodeRedirectUrl } from './lib/redirect';
import type { ArticleArgs } from './lib/arg';

declare const __CDP_ARG__: ArticleArgs;

/** 跳过不进入文章内容的标签。 */
const NOISE = new Set([
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'SVG',
  'PATH',
  'USE',
  'SOURCE',
  'PICTURE',
  'IFRAME',
]);

/** 链接黑名单模式数组(Node 侧 ignore-links.ts 读入后经 __CDP_ARG__ 传入)。 */
const ignoreLinks: string[] = __CDP_ARG__.ignoreLinks || [];
/** 块元素:walkEl 单独成块,inlineContent 遇到即停(不内联拉平)。 */
const BLOCK_TAGS = new Set(['P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE']);
/** 交互元素:降级为 [label] 行内标注。 */
const INTERACTIVE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

(() => {
  const base = refElement(__CDP_ARG__.ref);
  if (!base) return setResult(notFoundResult({ ref: __CDP_ARG__.ref } as OperableArg));
  const el = climbAncestors(base, __CDP_ARG__.ancestor || 0);
  if (!el)
    return setResult({ ok: false, err: `ref=${__CDP_ARG__.ref} 向上爬 ${__CDP_ARG__.ancestor || 0} 层后无元素` });

  const out: string[] = [];
  let cur = '';
  // 收拢当前行(行内文本),非空则落盘。
  const flush = () => {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
    cur = '';
  };
  // 发一个块:先收拢行内,再补空行分隔,最后 push 块文本。
  const block = (t: string) => {
    flush();
    if (!t) return;
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(t);
  };
  // 行内追加(不立即 collapse,块收拢时统一)。
  const inline = (t: string) => {
    if (t) cur += t;
  };

  /** 元素的直接文本(穿透不进子元素),空白归一化。链接/按钮用 own 文本避免子树聚合误导。 */
  const ownText = (e: Element): string => ownElText(e);

  /** 单个内联元素 → 行内 Markdown(链接/图片/粗斜/代码/交互降级;透明容器递归)。 */
  function inlineSeg(e: Element, depth: number): string {
    const tag = e.tagName;
    if (tag === 'A') {
      const t = ownText(e) || inlineContent(e, depth + 1);
      const h = e.getAttribute('href') || '';
      // 命中链接黑名单(如知乎词汇释义内部链接):只留文本、去 URL。
      // 未忽略的合法链接输出时把跳转包装(link.zhihu.com/?target=...)解回真实目标 URL。
      return h && !linkIgnored(ignoreLinks, h) ? `[${t}](${decodeRedirectUrl(h)})` : t;
    }
    if (tag === 'IMG') {
      const a = e.getAttribute('alt') || '';
      const s = e.getAttribute('src') || '';
      return a || s ? `![${a}](${s})` : '';
    }
    if (tag === 'B' || tag === 'STRONG') {
      const t = inlineContent(e, depth + 1).trim();
      return t ? `**${t}**` : '';
    }
    if (tag === 'EM' || tag === 'I') {
      const t = inlineContent(e, depth + 1).trim();
      return t ? `*${t}*` : '';
    }
    if (tag === 'CODE') {
      const t = (e.textContent || '').trim();
      return t ? '`' + t + '`' : '';
    }
    if (tag === 'BR') return '  ';
    if (INTERACTIVE.has(tag)) {
      const l = elLabel(e);
      return l ? `[${l}]` : '';
    }
    return inlineContent(e, depth + 1); // 透明容器(span/div 等)
  }

  /** 收集一个块(或容器)内的行内内容,保序;遇块元素即停(交给 walkEl 单独成块)。 */
  function inlineContent(el: Element, depth = 0): string {
    if (depth > 20) return '';
    let s = '';
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) {
        s += n.nodeValue || '';
        continue;
      }
      if (n.nodeType !== 1) continue;
      const e = n as Element;
      if (NOISE.has(e.tagName)) continue;
      if (BLOCK_TAGS.has(e.tagName)) continue; // 块元素不内联
      s += inlineSeg(e, depth);
    }
    return s;
  }

  /** 列表(el 为 UL/OL)。嵌套列表缩进 2 空格。 */
  function list(el: Element, indent: number): void {
    const ordered = el.tagName === 'OL';
    flush();
    if (out.length && out[out.length - 1] !== '') out.push('');
    let i = 1;
    for (const li of Array.from(el.children)) {
      if (li.tagName !== 'LI') continue;
      const pad = '  '.repeat(indent);
      const marker = ordered ? `${i++}.` : '-';
      const t = inlineContent(li as Element)
        .replace(/\s+/g, ' ')
        .trim();
      out.push(pad + marker + ' ' + t);
      for (const c of Array.from(li.children)) {
        if (c.tagName === 'UL' || c.tagName === 'OL') list(c as Element, indent + 1);
      }
    }
    cur = '';
  }

  /** 遍历块级元素,按 tag 语义发 Markdown;透明容器下钻。 */
  function walkEl(el: Element): void {
    const tag = el.tagName;
    if (NOISE.has(tag)) return;
    if (tag === 'P') {
      const t = inlineContent(el).replace(/\s+/g, ' ').trim();
      if (t) block(t);
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      const t = inlineContent(el).replace(/\s+/g, ' ').trim();
      block('#'.repeat(+tag[1]) + (t ? ' ' + t : ''));
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      list(el, 0);
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      const t = inlineContent(el).replace(/\s+/g, ' ').trim();
      if (t) block('> ' + t);
      return;
    }
    if (tag === 'PRE') {
      const t = (el.textContent || '').replace(/^\n+|\s+$/g, '');
      block('```\n' + t + '\n```');
      return;
    }
    if (tag === 'HR') {
      block('---');
      return;
    }
    if (tag === 'TABLE') return; // 简化:跳过表格
    if (tag === 'LI') {
      const t = inlineContent(el).replace(/\s+/g, ' ').trim();
      if (t) block('- ' + t);
      return;
    }
    if (
      tag === 'A' ||
      tag === 'IMG' ||
      tag === 'B' ||
      tag === 'STRONG' ||
      tag === 'EM' ||
      tag === 'I' ||
      tag === 'CODE' ||
      INTERACTIVE.has(tag)
    ) {
      inline(inlineSeg(el, 0));
      return;
    }
    // 透明容器(div/section/article/main/span 等):下钻
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) {
        const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (t) inline(t);
        continue;
      }
      if (n.nodeType === 1) walkEl(n as Element);
    }
  }

  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) {
      const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (t) inline(t);
      continue;
    }
    if (n.nodeType === 1) walkEl(n as Element);
  }
  flush();
  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return setResult({ ok: true, markdown: text, lines: text.split('\n') });
})();
