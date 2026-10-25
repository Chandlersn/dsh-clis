import { Context } from '@deepseek-ai/cordis';

import * as classifierPlugin from '@clis/clis-classifier';
import * as feedbackPlugin from '@clis/clis-feedback';
import * as orchestratorPlugin from '@clis/clis-orchestrator';
import * as strategyPlugin from '@clis/clis-strategy';
import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_ORCHESTRATOR_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  ClisContractError,
} from '@clis/clis-contracts';
import type {
  ActionExecutor,
  ActionInvocation,
  ActionResult,
  CausalProblem,
  FourAnswers,
  TriState,
} from '@clis/clis-contracts';

/** 四个插件的装载顺序（也是文档里承诺的协作顺序）。 */
export const PLUGINS = [
  classifierPlugin,
  strategyPlugin,
  feedbackPlugin,
  orchestratorPlugin,
] as const;

export const SERVICE_NAMES = [
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_ORCHESTRATOR_SERVICE,
] as const;

/** 按顺序装载全部四个插件，返回就绪的 Context。 */
export async function bootAll(): Promise<Context> {
  const ctx = new Context();
  for (const plugin of PLUGINS) {
    await ctx.plugin(plugin);
  }
  return ctx;
}

export function answers(q1: TriState, q2: TriState, q3: TriState, q4: TriState): FourAnswers {
  return {
    q1_simultaneous_mutual_definition: q1,
    q2_delayed_mutual_influence: q2,
    q3_strict_irreversible_order: q3,
    q4_coexisting_causal_structures: q4,
  };
}

/** 造问题：默认是循环因果（Q2=yes）。 */
export function problem(
  q1: TriState = 'no',
  q2: TriState = 'yes',
  q3: TriState = 'no',
  q4: TriState = 'no',
  description = '端到端测试问题',
): CausalProblem {
  return { description, answers: answers(q1, q2, q3, q4) };
}

export interface RecordingExecutor extends ActionExecutor {
  readonly calls: ActionInvocation[];
}

/**
 * 记录调用序列的执行器。
 *
 * @param respond — 按调用返回回执；缺省全部 ok。
 */
export function recordingExecutor(
  respond: (invocation: ActionInvocation) => ActionResult = () => ({ status: 'ok', detail: '完成' }),
): RecordingExecutor {
  const calls: ActionInvocation[] = [];
  return {
    calls,
    async execute(invocation: ActionInvocation): Promise<ActionResult> {
      calls.push(invocation);
      return respond(invocation);
    },
  };
}

/** 断言某个服务在上下文里确实可用（或确实不可用）。 */
export function serviceOf(ctx: Context, name: (typeof SERVICE_NAMES)[number]): unknown {
  return ctx[name];
}

export { ClisContractError };
export type { CausalProblem, TriState };