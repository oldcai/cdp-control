/**
 * feedback-start.ts — 操作后自动反馈:启动阶段(注入入口)。
 * 装 MutationObserver 采集本次操作产生的 DOM 变化(新增节点 + 文本变化 + 白名单属性变化)。
 * 需与 feedback-collect 分两次 eval 协作:中间 Node 侧执行动作 + sleep 等待异步内容出现。
 */
import { setResult } from './lib/result';
import { startFeedback } from './lib/feedback';

(() => { startFeedback(); return setResult({ ok: true }); })();
