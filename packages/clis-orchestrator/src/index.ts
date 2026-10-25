import type { Context } from '@deepseek-ai/cordis';

import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
} from '@clis/clis-contracts';

import { OrchestratorServiceImpl } from './service';

/**
 * clis-orchestrator —— 只做编排：classifier → strategy → feedback → 决策。
 *
 * 不写因果判断规则、不写策略匹配规则、不写反馈检测规则；
 * 回退次数上限与震荡锁定由本插件负责（见 decide.ts）。
 */
export const name = 'clis-orchestrator';

/**
 * 注入三个服务的**抽象接口**：只调用，不 import 实现。
 * 这也保证 orchestrator 无法越界去"自己判类型/自己匹配策略/自己检测反馈"。
 */
export const inject: string[] = [
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
];

/** 装载插件：把编排服务注册到上下文（服务名 clis.causalOrchestrator）。 */
export function apply(ctx: Context): void {
  ctx.plugin(OrchestratorServiceImpl);
}

export { OrchestratorServiceImpl } from './service';
export { decide, ROLLBACK_LIMIT_DEFAULT, TYPE_LOCK_ROUNDS_DEFAULT, initialState } from './decide';