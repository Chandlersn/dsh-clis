import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';

import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_ORCHESTRATOR_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
} from '@clis/clis-contracts';
import type {
  OrchestratorDecision,
  OrchestratorOptions,
  OrchestratorRound,
  OrchestratorRunOptions,
  OrchestratorService,
  OrchestratorState,
  RoundTrace,
  StrategyBoundary,
  CausalProblem,
} from '@clis/clis-contracts';

import { decide, initialState } from './decide';

/**
 * 编排服务的 Cordis 实现。
 *
 * 通过 inject 拿到三个服务并**调用**它们，自己不含任何判据/策略/反馈规则。
 */
export class OrchestratorServiceImpl extends Service implements OrchestratorService {
  constructor(ctx: Context) {
    super(ctx, CAUSAL_ORCHESTRATOR_SERVICE);
  }

  /** 与纯函数 decide 结论完全一致的异步包装。 */
  async decide(
    round: OrchestratorRound,
    state: OrchestratorState,
    options?: OrchestratorOptions,
  ): Promise<{ decision: OrchestratorDecision; nextState: OrchestratorState }> {
    return decide(round, state, options);
  }

  /**
   * 串起一轮闭环：分类 → 生成路径 → 执行 → 反馈 → 决策。
   * 四个环节全部委托给注入的服务，本方法只做编排。
   */
  async runRound(
    problem: CausalProblem,
    boundary: StrategyBoundary,
    options: OrchestratorRunOptions,
  ): Promise<{ trace: RoundTrace; decision: OrchestratorDecision; state: OrchestratorState }> {
    const classifier = this.ctx[CAUSAL_CLASSIFIER_SERVICE];
    const strategy = this.ctx[CAUSAL_STRATEGY_SERVICE];
    const feedback = this.ctx[CAUSAL_FEEDBACK_SERVICE];

    const classification = await classifier.classify(problem);

    let path = options.path;
    if (path === undefined) {
      const candidates = await strategy.match(classification, boundary);
      path = candidates.find((candidate) => candidate.executable) ?? candidates[0];
    }
    if (path === undefined) {
      throw new Error('策略未生成任何候选路径，无法编排本轮');
    }

    const execution = await strategy.execute(path, {
      boundary,
      executor: options.executor,
    });

    const signal = await feedback.detect({
      result: execution,
      classification: {
        causal_type: classification.causal_type,
        confidence: classification.confidence,
      },
      boundary: { forbidden_actions: boundary.forbidden_actions },
    });

    const state = options.state ?? initialState();
    const { decision, nextState } = decide(
      {
        problem,
        boundary,
        path,
        execution,
        signal,
        causal_type: classification.causal_type,
      },
      state,
      options,
    );

    const trace = nextState.traces[nextState.traces.length - 1];
    if (trace === undefined) {
      throw new Error('决策未产生 trace —— 违反「完整 trace」硬约束');
    }

    return { trace, decision, state: nextState };
  }
}