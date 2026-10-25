import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';

import { CAUSAL_CLASSIFIER_SERVICE } from '@clis/clis-contracts';
import type {
  CausalClassification,
  CausalClassifierService,
  CausalProblem,
  ClassifyOptions,
} from '@clis/clis-contracts';

import { classifyProblem } from './rules';

/**
 * 分类器服务的 Cordis 实现。
 *
 * `super(ctx, CAUSAL_CLASSIFIER_SERVICE)` 立即把本实例注册到上下文，
 * 并随所属 fiber 卸除 —— 生命周期交给 Cordis，插件自己不管状态。
 */
export class ClassifierService extends Service implements CausalClassifierService {
  constructor(ctx: Context) {
    super(ctx, CAUSAL_CLASSIFIER_SERVICE);
  }

  /** 与纯函数 classifyProblem 结论完全一致的异步包装。 */
  async classify(
    problem: CausalProblem,
    options?: ClassifyOptions,
  ): Promise<CausalClassification> {
    return classifyProblem(problem, options);
  }
}