/**
 * feedback-collect.ts — 操作后自动反馈:收尾阶段(注入入口)。
 * 断开 observer,把本次新增内容块逐块 view 拼接，并产出文本/白名单属性摘要。与 feedback-start 分两次 eval 协作。
 */
import { setResult } from './lib/result';
import { collectFeedback } from './lib/feedback';

(() => { return setResult({ ok: true, ...collectFeedback({ viewport: true }) }); })();
