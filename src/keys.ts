/**
 * keys.ts — 键盘键名 → CDP key/code/虚拟键码 的解析(纯函数,可单测)。
 * 支持 Ctrl/Shift/Alt/Meta 组合(Ctrl+Shift+A 写法)与常见功能键。
 */

// 功能键 → CDP key/code/虚拟键码 + 可选 CDP scroll commands(滚动类键才填)
// commands 字段透传到 Input.dispatchKeyEvent 的 keyDown 调用,触发浏览器内置滚动行为
// (光发 keyDown/keyUp 事件到 JS 层不触发原生滚动)。CDP 合法 command:
// scrollPageUp/scrollPageDown/scrollLineUp/scrollLineDown/scrollDocumentBegin/scrollDocumentEnd
const KEYMAP: Record<string, { key: string; code: string; kc: number; commands?: string[] }> = {
  enter: { key: 'Enter', code: 'Enter', kc: 13 },
  tab: { key: 'Tab', code: 'Tab', kc: 9 },
  escape: { key: 'Escape', code: 'Escape', kc: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', kc: 8 },
  delete: { key: 'Delete', code: 'Delete', kc: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', kc: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', kc: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', kc: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', kc: 39 },
  home: { key: 'Home', code: 'Home', kc: 36, commands: ['scrollDocumentBegin'] },
  end: { key: 'End', code: 'End', kc: 35, commands: ['scrollDocumentEnd'] },
  pageup: { key: 'PageUp', code: 'PageUp', kc: 33, commands: ['scrollPageUp'] },
  pagedown: { key: 'PageDown', code: 'PageDown', kc: 34, commands: ['scrollPageDown'] },
  space: { key: ' ', code: 'Space', kc: 32 },
  f5: { key: 'F5', code: 'F5', kc: 116 },
};

export interface ParsedKey {
  key: string;
  code: string;
  kc: number;
  modifiers: number;
  commands?: string[];
}

export function parseKeySpec(spec: string): ParsedKey {
  const parts = String(spec)
    .toLowerCase()
    .split('+')
    .map(s => s.trim())
    .filter(Boolean);
  let modifiers = 0,
    main = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') modifiers |= 2;
    else if (p === 'shift') modifiers |= 8;
    else if (p === 'alt') modifiers |= 1;
    else if (p === 'meta' || p === 'win' || p === 'cmd') modifiers |= 4;
    else main = p;
  }
  if (!main) throw new Error('按键描述缺少主键,如 Ctrl+A / Enter');
  if (main.length === 1) {
    const up = main.toUpperCase();
    const kc = main === ' ' ? 32 : up.charCodeAt(0);
    const code =
      main === ' ' ? 'Space' : /[0-9]/.test(main) ? 'Digit' + main : /[A-Z]/.test(up) ? 'Key' + up : 'Unknown';
    return { key: main === ' ' ? ' ' : up, code, kc, modifiers };
  }
  const m = KEYMAP[main];
  if (m) return { ...m, modifiers };
  throw new Error(
    `未知按键: ${main}(支持 Ctrl/Shift/Alt 组合,如 Ctrl+Shift+A;功能键: Enter/Tab/Escape/Arrow/Home/F5 等)`,
  );
}
