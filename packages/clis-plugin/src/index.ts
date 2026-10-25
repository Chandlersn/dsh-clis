import type { Context } from '@deepseek-ai/cordis';

import { apply as applyClassifier } from '@clis/clis-classifier';
import { apply as applyFeedback } from '@clis/clis-feedback';
import { apply as applyOrchestrator } from '@clis/clis-orchestrator';
import { apply as applyStrategy } from '@clis/clis-strategy';

/**
 * CLIS 单一插件入口（Host 侧）。
 *
 * 四个子插件按固定顺序装载：
 *   classifier → strategy → feedback → orchestrator
 *
 * 顺序不是任意的：strategy 的 inject 依赖 classifier 的服务名，
 * orchestrator 的 inject 同时依赖三者。Cordis 的 inject 会等依赖就位，
 * 所以顺序错了也不会崩，但按依赖顺序装载能让服务更早可用。
 *
 * 用户可在 Plugin Manager 里手动开启/关闭本插件；
 * agent 可用 plugin_manager 工具热插拔（dsh.bundle 声明让它在面板里可见）。
 */
export const name = 'clis';

/** 无外部服务依赖：四个子插件的依赖都在内部满足。 */
export const inject: string[] = [];

/**
 * 装载全部四个子插件。
 *
 * @param ctx — 插件上下文。
 */
export function apply(ctx: Context): void {
  applyClassifier(ctx);
  applyStrategy(ctx);
  applyFeedback(ctx);
  applyOrchestrator(ctx);
}

export { classifyProblem } from '@clis/clis-classifier';
export { matchPaths, executePath, STRATEGY_LIBRARY, STRATEGY_LIBRARY_VERSION } from '@clis/clis-strategy';
export { detectSignal, FEEDBACK_RULES_VERSION } from '@clis/clis-feedback';
export { decide, initialState, ROLLBACK_LIMIT_DEFAULT, TYPE_LOCK_ROUNDS_DEFAULT } from '@clis/clis-orchestrator';
