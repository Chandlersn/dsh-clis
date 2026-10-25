import type { FourAnswers } from './questions';

/**
 * 分类器的输入：结构化问题。
 *
 * 判据只由 answers 决定，description 只作为上下文进入证据文本 —— 这是有意的边界：
 * 同一份作答必然算出同一个结论，评审与回放都无需重跑语义理解。
 */
export interface CausalProblem {
  /** 问题描述；允许空串，但字段必须存在。 */
  readonly description: string;
  readonly answers: FourAnswers;
  /** 嵌套类型的子问题，用于生成 sub_modules。 */
  readonly sub_problems?: readonly CausalProblem[];
  /** 可选的人类可读标签；作为该问题在 sub_modules[].name 中的名字。 */
  readonly label?: string;
}

/** classify 的可选参数。 */
export interface ClassifyOptions {
  /** 嵌套递归深度上限（整数，0..MAX_DEPTH_LIMIT）；缺省为 DEFAULT_MAX_DEPTH。 */
  readonly max_depth?: number;
}