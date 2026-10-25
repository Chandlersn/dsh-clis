import type { Context } from '@deepseek-ai/cordis';

import { FeedbackServiceImpl } from './service';

/**
 * clis-feedback —— 只做反馈信号检测、类型误判识别、回退建议输出。
 *
 * 不重新判断因果类型（不调用 classifier）、不自动执行回退、不修改系统状态；
 * 只依赖 @clis/clis-contracts，不 import 任何其它 CLIS 插件的实现文件。
 */
export const name = 'clis-feedback';

/**
 * 无服务依赖。
 * 这一点是刻意的：feedback 判定"类型是否被误判"，但**不许自己重新分类**，
 * 所以它连分类器都不注入 —— 从依赖图层面就杜绝了越界。
 */
export const inject: string[] = [];

/** 装载插件：把反馈服务注册到上下文（服务名 clis.causalFeedback）。 */
export function apply(ctx: Context): void {
  ctx.plugin(FeedbackServiceImpl);
}

export { FeedbackServiceImpl } from './service';
export { detectSignal, FEEDBACK_RULES_VERSION } from './detect';