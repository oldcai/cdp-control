import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mouseClickEvents } from '../src/click-events.ts';

test('mouseClickEvents: 按 moved → pressed → released 生成左键单击序列', () => {
  assert.deepEqual(mouseClickEvents({ x: 12.5, y: 8.25 }), [
    { type: 'mouseMoved', x: 12.5, y: 8.25 },
    { type: 'mousePressed', x: 12.5, y: 8.25, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 12.5, y: 8.25, button: 'left', buttons: 0, clickCount: 1 },
  ]);
});
