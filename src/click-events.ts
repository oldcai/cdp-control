/** click-events.ts — 生成一次 trusted 左键单击的 CDP 鼠标事件序列。 */

export interface MousePoint { x: number; y: number }

export type MouseClickEvent =
  | { type: 'mouseMoved'; x: number; y: number }
  | { type: 'mousePressed'; x: number; y: number; button: 'left'; buttons: 1; clickCount: 1 }
  | { type: 'mouseReleased'; x: number; y: number; button: 'left'; buttons: 0; clickCount: 1 };

export function mouseClickEvents({ x, y }: MousePoint): MouseClickEvent[] {
  return [
    { type: 'mouseMoved', x, y },
    { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 },
  ];
}
