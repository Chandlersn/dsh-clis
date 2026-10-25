import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';

import { CAUSAL_CLASSIFIER_SERVICE, CAUSAL_STRATEGY_SERVICE } from '@clis/clis-contracts';
import type {
  CandidatePath,
  CausalClassification,
  CausalProblem,
  ClassifyOptions,
  ExecutePathOptions,
  ExecutionResult,
  StrategyBoundary,
  StrategyMatchOptions,
  StrategyService,
} from '@clis/clis-contracts';

import { executePath } from './execution';
import { matchPaths } from './paths';

/**
 * 策略服务的 Cordis 实现。
 *
 * 因为 `inject` 声明了分类器，本插件只在分类器就位后才装载；
 * `plan()` 通过注入的抽象接口**读取**类型，匹配逻辑全在 `matchPaths` 里。
 */
export class StrategyServiceImpl extends Service implements StrategyService {
  constructor(ctx: Context) {
    super(ctx, CAUSAL_STRATEGY_SERVICE);
  }

  /** 与纯函数 matchPaths 结论完全一致的异步包装。 */
  async match(
    classification: CausalClassification,
    boundary: StrategyBoundary,
    options?: StrategyMatchOptions,
  ): Promise<readonly CandidatePath[]> {
    return matchPaths(classification, boundary, options);
  }

  /** 先向注入的分类器读取类型，再匹配。 */
  async plan(
    problem: CausalProblem,
    boundary: StrategyBoundary,
    options?: ClassifyOptions,
  ): Promise<readonly CandidatePath[]> {
    const classifier = this.ctx[CAUSAL_CLASSIFIER_SERVICE];
    const classification = await classifier.classify(problem, options);
    return matchPaths(classification, boundary);
  }

  /** 与纯函数 executePath 结论完全一致的异步包装。 */
  async execute(path: CandidatePath, options: ExecutePathOptions): Promise<ExecutionResult> {
    return executePath(path, options);
  }
}