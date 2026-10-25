import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';

import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_ORCHESTRATOR_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
} from '@clis/clis-contracts';
import type {
  ActionExecutor,
  OrchestratorDecision,
  OrchestratorOptions,
  OrchestratorRound,
  OrchestratorRunOptions,
  OrchestratorRunResult,
  OrchestratorService,
  OrchestratorState,
  RoundTrace,
  RunOptions,
  StrategyBoundary,
  CausalProblem,
  ExecutionResult,
  FeedbackSignal,
} from '@clis/clis-contracts';

import { decide, initialState, ROLLBACK_LIMIT_DEFAULT } from './decide';

/** run() 的轮数保护上限，防止闭环失控。 */
const DEFAULT_MAX_ROUNDS = 32;

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
   * 跑完整闭环：分类 → 匹配 → 执行 → 反馈 → 继续/换路径/回退/锁定，
   * 直到拿到有效结果、或回退耗尽转人工介入、或无可用路径。
   *
   * 这里只有"编排"：所有判断、匹配、反馈都委托给注入的服务。
   */
  async run(problem: CausalProblem, options: RunOptions = {}): Promise<OrchestratorRunResult> {
    const classifier = this.ctx[CAUSAL_CLASSIFIER_SERVICE];
    const strategy = this.ctx[CAUSAL_STRATEGY_SERVICE];
    const feedback = this.ctx[CAUSAL_FEEDBACK_SERVICE];

    const boundary: StrategyBoundary = options.boundary ?? { forbidden_actions: [] };
    const executor: ActionExecutor =
      options.executor ?? { execute: async () => ({ status: 'ok', detail: '默认执行器：视为成功' }) };
    const maxRounds = options.max_rounds ?? DEFAULT_MAX_ROUNDS;

    let state = options.state ?? initialState();
    let classification = await classifier.classify(problem);
    let paths = await strategy.match(classification, boundary);
    let pathIndex = 0;

    let execution: ExecutionResult | undefined;
    let signal: FeedbackSignal | undefined;
    let decision: OrchestratorDecision = {
      action: 'continue',
      reason: '尚未开始',
      rollback_count: state.rollback_count,
    };

    for (let guard = 0; guard < maxRounds; guard += 1) {
      const candidate = paths[pathIndex];
      if (candidate === undefined) {
        return {
          outcome: 'exhausted',
          state,
          classification,
          decision,
          reason: `候选路径已用尽（类型 ${classification.causal_type}），无可用路径可继续`,
          ...(execution !== undefined ? { execution } : {}),
          ...(signal !== undefined ? { signal } : {}),
        };
      }

      execution = await strategy.execute(candidate, { boundary, executor });
      signal = await feedback.detect({
        result: execution,
        classification: {
          causal_type: classification.causal_type,
          confidence: classification.confidence,
        },
        boundary: { forbidden_actions: boundary.forbidden_actions },
      });

      const outcome = decide(
        {
          problem,
          boundary,
          path: candidate,
          execution,
          signal,
          causal_type: classification.causal_type,
        },
        state,
        options,
      );
      decision = outcome.decision;
      state = outcome.nextState;

      if (decision.action === 'continue' || decision.action === 'lock_and_continue') {
        return {
          outcome: 'effective',
          state,
          classification,
          execution,
          signal,
          decision,
          reason:
            decision.action === 'continue'
              ? '闭环完成：结果有效'
              : '闭环完成：震荡锁定期内按当前类型继续，未触发回退',
        };
      }

      if (decision.action === 'manual_intervention') {
        return {
          outcome: 'manual_intervention',
          state,
          classification,
          execution,
          signal,
          decision,
          reason: `回退次数已达上限（${state.rollback_count}/${options.rollback_limit ?? ROLLBACK_LIMIT_DEFAULT}）：需人工介入，完整 trace 已保留`,
        };
      }

      if (decision.action === 'switch_path') {
        // 不换类型，只换路径。若已无更多路径可用，则退回重新分类
        // （而不是直接报 exhausted —— 类型假设可能确实是错的，回退机会不该被路径数量耗尽）。
        if (pathIndex + 1 < paths.length) {
          pathIndex += 1;
          continue;
        }
        if (state.rollback_count < (options.rollback_limit ?? ROLLBACK_LIMIT_DEFAULT)) {
          classification = await classifier.classify(problem);
          paths = await strategy.match(classification, boundary);
          pathIndex = 0;
          state = {
            ...state,
            rollback_count: state.rollback_count + 1,
          };
          continue;
        }
        return {
          outcome: 'manual_intervention',
          state,
          classification,
          decision: {
            action: 'manual_intervention',
            reason: `候选路径已用尽且回退次数已达上限：需人工介入`,
            rollback_count: state.rollback_count,
          },
          execution,
          signal,
          reason: '候选路径已用尽且回退次数已达上限：需人工介入',
        };
      }

      if (decision.action === 'rollback_to_classifier') {
        // 回到分类器重新判断。problem 不变时结论通常相同，故这里只重置路径游标，
        // 由震荡锁定与回退上限兜住"同一类型反复回退"的死循环。
        classification = await classifier.classify(problem);
        paths = await strategy.match(classification, boundary);
        pathIndex = 0;
        continue;
      }

      if (decision.action === 'rollback_to_boundary') {
        // 回到边界设定：调用方未提供新边界时，退回空黑名单重试一轮。
        paths = await strategy.match(classification, boundary);
        pathIndex = 0;
        continue;
      }
    }

    return {
      outcome: 'manual_intervention',
      state,
      classification,
      decision,
      reason: `已达最大轮数保护上限 ${maxRounds}：停止闭环，需人工介入`,
      ...(execution !== undefined ? { execution } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
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