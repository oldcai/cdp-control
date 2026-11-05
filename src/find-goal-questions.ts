/**
 * find-goal-questions.ts — find --goal 问 Jev 的全部文案与判定常量(改文案/阈值只动这里)。
 *
 * 判断交给模型,决策写在代码:Choice 选元素,Noul 判"页面上有没有",阈值映射成 有/不确定/无。
 * 模型钉死版本,不用 jev-latest:别名漂移会悄悄改变答案。
 */

export const JEV_MODEL = 'jev-1.14.0';

/** Choice 每题上限 255 个选项(API maxProperties),留余量按 250 分块海选。 */
export const HEAT_SIZE = 250;
/** 每块晋级决赛的名额。 */
export const FINALISTS_PER_HEAT = 3;
/** 单元素行截断长度(字符):实测紧凑形式准确率与完整树相同,token 少 22%。 */
export const LINE_MAX = 160;
/** Noul 阈值:>YES 有,<NO 无,中间是"不确定",不能当无解。 */
export const EXISTS_YES_ABOVE = 0.7;
export const EXISTS_NO_BELOW = 0.3;
/** 默认候选数。 */
export const DEFAULT_LIMIT = 5;

export const choiceInstructions = (goal: string): string =>
  `A user wants to: "${goal}". Which element in \`elements\` should they use? Each option is the element's rN id.`;

export const existsInstructions = (goal: string): string =>
  `Does \`elements\` contain an element a user could use to: "${goal}"?`;
