import type { Context } from '@deepseek-ai/cordis';

import type { StrategyBoundary } from './boundary';
import type { CausalClassification } from './classification';
import type { CausalProblem, ClassifyOptions } from './problem';
import type { CandidatePath, ExecutePathOptions, ExecutionResult } from './strategy';

/**
 * 服务在 Cordis 上下文中的注册名。
 * 四个插件靠这些名字互相寻址（inject），绝不互相 import 实现文件。
 */
export const CAUSAL_CLASSIFIER_SERVICE = 'clis.causalClassifier';
export const CAUSAL_STRATEGY_SERVICE = 'clis.causalStrategy';

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

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 由 clis-classifier 提供；消费方须先 inject 该服务名。 */
    'clis.causalClassifier': CausalClassifierService;
    /** 由 clis-strategy 提供；消费方须先 inject 该服务名。 */
    'clis.causalStrategy': StrategyService;
  }
}

export type { Context };