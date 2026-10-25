import type { Context } from '@deepseek-ai/cordis';

import { ClassifierService } from './service';

/**
 * clis-classifier —— 只做因果类型判断。
 *
 * 不生成策略、不执行动作、不评价策略好坏、不决定回退；
 * 只依赖 @clis/clis-contracts 的类型与接口，不 import 任何其它 CLIS 插件实现。
 */
export const name = 'clis-classifier';

/** 无服务依赖：判据只吃输入，不需要别的插件先就位。 */
export const inject: string[] = [];

/** 装载插件：把分类器服务注册到上下文（服务名 clis.causalClassifier）。 */
export function apply(ctx: Context): void {
  ctx.plugin(ClassifierService);
}

export { ClassifierService } from './service';
export { classifyProblem } from './rules';