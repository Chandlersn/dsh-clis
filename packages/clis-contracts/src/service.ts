import type { Context } from '@deepseek-ai/cordis';

import type { CausalClassification } from './classification';
import type { CausalProblem, ClassifyOptions } from './problem';

/**
 * 分类器服务在 Cordis 上下文中的注册名。
 * 四个插件靠这个名字互相寻址（inject），绝不互相 import 实现文件。
 */
export const CAUSAL_CLASSIFIER_SERVICE = 'clis.causalClassifier';

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

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 由 clis-classifier 提供；消费方须先 inject 该服务名。 */
    'clis.causalClassifier': CausalClassifierService;
  }
}

export type { Context };