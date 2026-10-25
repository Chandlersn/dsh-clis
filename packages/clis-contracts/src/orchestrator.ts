import type { CausalType, KnownCausalType } from './causal-type';
import type { FeedbackSignal } from './feedback';
import type { CausalProblem } from './problem';
import type { CandidatePath, ExecutionResult } from './strategy';
import type { StrategyBoundary } from './boundary';

/**
 * orchestrator 的决策种类。
 *
 * 六种：继续当前路径、换一条路径、回退到重新分类、回退到重新设定边界、
 * 锁定当前类型再走一轮、需人工介入（回退次数耗尽）。
 */
export const ORCHESTRATOR_ACTIONS = [
  'continue',
  'switch_path',
  'rollback_to_classifier',
  'rollback_to_boundary',
  'lock_and_continue',
  'manual_intervention',
] as const;

export type OrchestratorAction = (typeof ORCHESTRATOR_ACTIONS)[number];

/** 一轮闭环的轨迹记录。 */
export interface RoundTrace {
  /** 轮次，从 1 起。 */
  readonly round: number;
  readonly causal_type: CausalType;
  readonly path_id: string;
  readonly execution_status: ExecutionResult['status'];
  readonly signal_type: FeedbackSignal['signal_type'];
  /** 本轮做出的决策。 */
  readonly action: OrchestratorAction;
  /** 累计回退次数（本轮决策之后）。 */
  readonly rollback_count: number;
  /** 一句话说明。 */
  readonly note: string;
}

/** orchestrator 的决策结果。 */
export interface OrchestratorDecision {
  readonly action: OrchestratorAction;
  /** 需要重新分类时的建议类型；仅 rollback_to_classifier 可能出现。 */
  readonly retry_type?: KnownCausalType;
  /** 需要换路径时的目标 path_id；仅 switch_path 出现。 */
  readonly next_path_id?: string;
  /** 一句话理由，恒非空。 */
  readonly reason: string;
  /** 累计回退次数（本次决策之后）。 */
  readonly rollback_count: number;
  /** 当前被锁定的类型；仅 lock_and_continue 或锁定生效时出现。 */
  readonly locked_type?: CausalType;
}

/** 震荡保护状态：同一类型连续被回退的记录。 */
export interface OscillationState {
  /** 每个类型连续被回退的次数。 */
  readonly consecutive_rollbacks: Readonly<Record<string, number>>;
  /** 当前被锁定的类型；未锁定则不存在。 */
  readonly locked_type?: CausalType;
  /** 锁定还剩几轮解除。 */
  readonly lock_remaining: number;
}

/** 闭环的完整状态，由调用方持有并逐轮传入（orchestrator 自身无状态）。 */
export interface OrchestratorState {
  readonly round: number;
  readonly rollback_count: number;
  readonly oscillation: OscillationState;
  readonly traces: readonly RoundTrace[];
}

/** 一轮的输入。 */
export interface OrchestratorRound {
  readonly problem: CausalProblem;
  readonly boundary: StrategyBoundary;
  /** 本轮选中的路径（首轮由 orchestrator 生成）。 */
  readonly path: CandidatePath;
  readonly execution: ExecutionResult;
  readonly signal: FeedbackSignal;
  /** 本轮的分类结论类型（只读）。 */
  readonly causal_type: CausalType;
}

/** run 的可选参数。 */
export interface OrchestratorOptions {
  /** 回退次数上限；缺省 ROLLBACK_LIMIT(3)。 */
  readonly rollback_limit?: number;
  /** 震荡锁定时长（轮）；缺省 TYPE_LOCK_ROUNDS(1)。 */
  readonly lock_rounds?: number;
}

/** 初始状态。 */
export function initialState(): OrchestratorState {
  return {
    round: 0,
    rollback_count: 0,
    oscillation: { consecutive_rollbacks: {}, lock_remaining: 0 },
    traces: [],
  };
}