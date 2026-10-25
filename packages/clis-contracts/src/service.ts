import type { Context } from '@deepseek-ai/cordis';

import type { StrategyBoundary } from './boundary';
import type { CausalClassification } from './classification';
import type { DetectOptions, FeedbackRequest, FeedbackSignal } from './feedback';
import type {
  OrchestratorDecision,
  OrchestratorOptions,
  OrchestratorRound,
  OrchestratorRunResult,
  OrchestratorState,
  RoundTrace,
  RunOptions,
} from './orchestrator';
import type { CausalProblem, ClassifyOptions } from './problem';
import type { CandidatePath, ExecutePathOptions, ExecutionResult } from './strategy';

/**
 * 服务在 Cordis 上下文中的注册名。
 * 四个插件靠这些名字互相寻址（inject），绝不互相 import 实现文件。
 */
export const CAUSAL_CLASSIFIER_SERVICE = 'clis.causalClassifier';
export const CAUSAL_STRATEGY_SERVICE = 'clis.causalStrategy';
export const CAUSAL_FEEDBACK_SERVICE = 'clis.causalFeedback';
export const CAUSAL_ORCHESTRATOR_SERVICE = 'clis.causalOrchestrator';

/** clis-classifier 对外暴露的唯一能力面。 */
export interface CausalClassifierService {
  /**
   * 判断因果类型。
   *
   * @param problem — 结构化问题（描述 + 四问作答 + 可选子问题）。
   * @param options — 可选参数（嵌套深度上限）。
   * @returns 分类结论；畸形输入抛 ClisContractError，不返回兜底结论。
   */
  classify(problem: CausalProblem, options?: ClassifyOptions): Promise<CausalClassification>;
}

/** clis-strategy 对外暴露的能力面。 */
export interface StrategyService {
  /**
   * 依据分类结论匹配策略、生成候选路径并排序。**不重新判断因果类型。**
   *
   * @param classification — 来自 clis-classifier 的结论。
   * @param boundary — 策略边界；其 forbidden_actions 内的动作绝不出现在 steps 中。
   * @returns 同级按 score 降序、名次从 1 起的候选路径；至少 1 条。
   */
  match(
    classification: CausalClassification,
    boundary: StrategyBoundary,
  ): Promise<readonly CandidatePath[]>;

  /**
   * 便捷入口：先向注入的 CausalClassifierService **读取**类型，再 match。
   * 类型判断完全由分类器完成，本方法不含任何判据。
   *
   * @param problem — 结构化问题。
   * @param boundary — 策略边界。
   * @param options — 透传给分类器的参数。
   * @returns 候选路径。
   */
  plan(
    problem: CausalProblem,
    boundary: StrategyBoundary,
    options?: ClassifyOptions,
  ): Promise<readonly CandidatePath[]>;

  /**
   * 执行一条候选路径。
   *
   * 绝不把 boundary 阻断的动作交给执行器（即使路径是调用方手搓的）；
   * **不自行决定回退**，只回执 status 与 signals。
   *
   * @param path — 要执行的路径。
   * @param options — 边界与执行器。
   * @returns 执行结论。
   */
  execute(path: CandidatePath, options: ExecutePathOptions): Promise<ExecutionResult>;
}

/** clis-feedback 对外暴露的能力面。 */
export interface FeedbackService {
  /**
   * 依据执行结果检测反馈信号、识别类型误判、提出回退建议。
   *
   * **不重新判断因果类型**（不调用 classifier）、**不自动执行回退**
   * （只输出 `suggested_rollback`）、**不修改任何系统状态**。
   *
   * @param request — 执行结果 + 当前类型假设（只读）+ 边界。
   * @param options — 历史轨迹等可选参数。
   * @returns 反馈信号；畸形输入抛 ClisContractError。
   */
  detect(request: FeedbackRequest, options?: DetectOptions): Promise<FeedbackSignal>;
}

/** clis-orchestrator 对外暴露的能力面。 */
export interface OrchestratorService {
  /**
   * 跑完整闭环，直到拿到有效结果或回退耗尽。
   *
   * 内部循环：分类 → 匹配 → 执行 → 反馈 → 继续/换路径/回退/锁定，
   * 回退次数上限与震荡锁定由本插件负责；超过上限输出 `manual_intervention` 并保留完整 trace。
   *
   * @param problem — 结构化问题。
   * @param options — 边界、执行器、回退上限、锁定时长。
   * @returns 终局、完整 trace 与最终决策。
   */
  run(problem: CausalProblem, options?: RunOptions): Promise<OrchestratorRunResult>;

  /**
   * 依据本轮的执行结果与反馈信号做出决策。
   *
   * orchestrator 自身**无状态**：状态由调用方持有并逐轮传入。
   * 它只编排（决定继续/换路径/回退/锁定/人工介入），**不含任何判据**。
   *
   * @param round — 本轮输入（路径、执行结果、反馈信号、类型假设）。
   * @param state — 当前闭环状态。
   * @param options — 回退上限与锁定时长。
   * @returns 决策与更新后的状态。
   */
  decide(
    round: OrchestratorRound,
    state: OrchestratorState,
    options?: OrchestratorOptions,
  ): Promise<{ decision: OrchestratorDecision; nextState: OrchestratorState }>;

  /**
   * 跑**一轮**闭环（分类 → 生成路径 → 执行 → 反馈 → 决策）。
   * 供调用方自行控制轮次时使用；`run()` 是它的自动循环版本。
   *
   * @param problem — 结构化问题。
   * @param boundary — 策略边界。
   * @param options — 回退上限、锁定时长与执行器。
   * @returns 本轮轨迹与决策。
   */
  runRound(
    problem: CausalProblem,
    boundary: StrategyBoundary,
    options: OrchestratorRunOptions,
  ): Promise<{ trace: RoundTrace; decision: OrchestratorDecision; state: OrchestratorState }>;
}

/** runRound 的依赖：执行器由调用方提供（不是 CLIS 插件）。 */
export interface OrchestratorRunOptions extends OrchestratorOptions {
  readonly executor: import('./strategy').ActionExecutor;
  readonly state?: OrchestratorState;
  /** 已选定的路径；缺省由 strategy 生成后取第一条可执行路径。 */
  readonly path?: CandidatePath;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 由 clis-classifier 提供；消费方须先 inject 该服务名。 */
    'clis.causalClassifier': CausalClassifierService;
    /** 由 clis-strategy 提供；消费方须先 inject 该服务名。 */
    'clis.causalStrategy': StrategyService;
    /** 由 clis-feedback 提供；消费方须先 inject 该服务名。 */
    'clis.causalFeedback': FeedbackService;
    /** 由 clis-orchestrator 提供；消费方须先 inject 该服务名。 */
    'clis.causalOrchestrator': OrchestratorService;
  }
}

export type { Context };