import type { CausalType, KnownCausalType } from './causal-type';
import type { CausalClassification } from './classification';
import type { FeedbackSignal, RollbackKind } from './feedback';
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
  /**
   * 回退建议的种类，原样取自 `signal.suggested_rollback.kind`；
   * 仅 rollback_to_classifier 可能出现。
   *
   * 为什么要带上它：feedback 契约刻意区分 `recheck_type`（换一种类型假设）
   * 与 `restore_type`（回到原类型再试），两者对调用方的含义完全不同。
   * 早先编排层只透传 `retry_type` 而丢掉 kind，这个区分就在这一层断了 ——
   * 调用方无法分辨"换个假设"还是"退回原样"。
   */
  readonly retry_kind?: RollbackKind;
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
  /**
   * 换路径时改用哪条路径（`signal_type === 'ineffective'` 时用）。
   *
   * 这个字段是 SPEC §3.5 明确要求调用方传入的，但早先**契约里漏了它** ——
   * 只有输出 `OrchestratorDecision.next_path_id` 有，输入的 round 没有。
   * 后果：类型安全的调用方根本传不进来，实现只能靠 `as` 断言去读一个
   * 未声明字段（见 `clis-orchestrator/src/decide.ts`），规格那一条在类型
   * 层面不可达。2026-10-26 由独立验收方只读规格 + 契约发现。
   *
   * 缺省（不传）时 `switch_path` 决策不设 `next_path_id`，仍输出该动作。
   */
  readonly next_path_id?: string;
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

/** run(problem) 的终局。 */
export const RUN_OUTCOMES = ['effective', 'manual_intervention', 'exhausted'] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** run(problem) 的返回。 */
export interface OrchestratorRunResult {
  /** effective=拿到有效结果；manual_intervention=回退耗尽需人工介入；exhausted=无可用路径。 */
  readonly outcome: RunOutcome;
  /** 完整 trace（永不丢弃）。 */
  readonly state: OrchestratorState;
  /** 最终采用的分类结论。 */
  readonly classification: CausalClassification;
  /** 最终执行结果；未执行时不存在。 */
  readonly execution?: ExecutionResult;
  /** 最终反馈信号；未执行时不存在。 */
  readonly signal?: FeedbackSignal;
  /** 最后一次决策。 */
  readonly decision: OrchestratorDecision;
  /** 一句话终局说明（恒非空）。 */
  readonly reason: string;
}

/** run(problem) 的可选参数。 */
export interface RunOptions extends OrchestratorOptions {
  /** 策略边界；缺省空黑名单。 */
  readonly boundary?: StrategyBoundary;
  /** 动作执行器；缺省为"全部成功"的空执行器（便于纯逻辑验证）。 */
  readonly executor?: import('./strategy').ActionExecutor;
  /** 起始状态；缺省 initialState()。 */
  readonly state?: OrchestratorState;
  /** 最大轮数保护（防止无限循环）；缺省 32。 */
  readonly max_rounds?: number;
  /**
   * 跨轮历史信号 —— 传给反馈服务判定「反复偏离」。
   *
   * 为什么必须由调用方注入：反馈服务**无状态**（不修改系统状态），
   * 它靠 `FeedbackHistory.previous_signals` 判断当前偏离是否属于「反复」。
   * 不传时反馈只能看到本轮，`type_misjudged`（契约要求「反复」偏离）
   * 永远不可能触发 —— 闭环会退化成一味地判 effective。
   *
   * 调用方应只传**同一因果类型假设下**的历史信号：换了假设，
   * 旧信号不再构成对当前假设的反证。
   */
  readonly history?: import('./feedback').FeedbackHistory;
}