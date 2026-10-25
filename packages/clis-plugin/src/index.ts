import type { Context } from '@deepseek-ai/cordis';

import { registerTools } from './tools';

/**
 * CLIS 包根入口 —— **只注册 agent 工具**，不装载四个组件。
 *
 * 职责划分：
 * - 四个组件各有独立入口（`dsh-clis/classifier` 等），由 patch 里的四行分别装载，
 *   因此它们可以在面板上各自开关。
 * - 包根入口只负责把三个工具（clis_run / clis_classify / clis_plan）注册给 agent。
 *
 * 为什么不用包根装载组件：那样会让四个组件被装载两次（包根 + 各自入口），
 * 造成服务重复注册。
 *
 * 为什么包根必须存在：Loader 解析 bundle 时先按 `exports["."]` 判断整包合法性，
 * 缺包根会导致整包被跳过（四个子行全部停在 absent）。
 *
 * 工具层只做转发，判据全部在四个组件里：
 * 分类 → classifier，匹配 → strategy，反馈 → feedback，编排 → orchestrator。
 */
export const name = 'clis-tools';

/**
 * 工具注册需要三个服务与 `tools`。
 *
 * 若某个组件被用户在面板上关闭，依赖它的工具会因 inject 不满足而停用 ——
 * 这是期望行为：关掉分类器，clis_classify 自然不可用。
 */
export const inject: string[] = [
  'tools',
  'clis.causalClassifier',
  'clis.causalStrategy',
  'clis.causalOrchestrator',
];

/**
 * 注册 CLIS 工具。
 *
 * @param ctx 插件上下文。
 */
export function apply(ctx: Context): void {
  registerTools(ctx);
}

export { classifyProblem } from '@clis/clis-classifier';
export { matchPaths, executePath, STRATEGY_LIBRARY, STRATEGY_LIBRARY_VERSION } from '@clis/clis-strategy';
export { detectSignal, FEEDBACK_RULES_VERSION } from '@clis/clis-feedback';
export { decide, initialState, ROLLBACK_LIMIT_DEFAULT, TYPE_LOCK_ROUNDS_DEFAULT } from '@clis/clis-orchestrator';
