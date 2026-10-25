import type { Context } from '@deepseek-ai/cordis';

import { CAUSAL_CLASSIFIER_SERVICE } from '@clis/clis-contracts';

import { StrategyServiceImpl } from './service';

/**
 * clis-strategy —— 只做策略匹配、候选路径生成、排序与执行。
 *
 * 不重新判断因果类型、不自行决定回退、不执行 boundary.forbidden_actions 中的动作；
 * 只依赖 @clis/clis-contracts，不 import 任何其它 CLIS 插件的实现文件。
 */
export const name = 'clis-strategy';

/**
 * 注入分类器的抽象接口：**只用于读取类型**。
 * 判据完全由 clis-classifier 负责，本插件不含任何分类逻辑。
 */
export const inject: string[] = [CAUSAL_CLASSIFIER_SERVICE];

/** 装载插件：把策略服务注册到上下文（服务名 clis.causalStrategy）。 */
export function apply(ctx: Context): void {
  ctx.plugin(StrategyServiceImpl);
}

export { StrategyServiceImpl } from './service';
export { matchPaths } from './paths';
export { executePath } from './execution';
export { STRATEGY_LIBRARY, STRATEGY_LIBRARY_VERSION, libraryVariant } from './library';
export type { LibraryStepSpec, LibraryVariant } from './library';