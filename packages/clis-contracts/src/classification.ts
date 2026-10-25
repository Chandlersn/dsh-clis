import type { CausalType, KnownCausalType } from './causal-type';
import type { QuestionId } from './questions';

/** 证据来源：四问之一、问题描述本身、某个子模块的结论，或一条判据规则。 */
export type EvidenceSource = QuestionId | 'DESCRIPTION' | 'SUBMODULE' | 'RULE';

/** 单条证据。statement 绝不允许是空串。 */
export interface Evidence {
  readonly source: EvidenceSource;
  /** 触发该证据的规则 id，用于回溯"为什么这么判"。 */
  readonly rule_id: string;
  /** 人类可读的一句话证据。 */
  readonly statement: string;
  /** 该证据支持的类型；unknown 结论一律用 'unknown'。 */
  readonly supports: CausalType;
  /** 支持强度 0..1；负证据与"仅陈述作答状态"的证据用 0。 */
  readonly weight: number;
}

/** 判据规则轨迹的一条：规则是否触发、触发后是什么后果。 */
export interface JudgmentBasis {
  readonly rule_id: string;
  readonly description: string;
  readonly fired: boolean;
  /** 该规则产生的后果；仅 fired=true 时有意义。 */
  readonly effect?: string;
}

/** unknown 时给出的候选假设：只列备选，不强行归类。 */
export interface CandidateHypothesis {
  readonly causal_type: KnownCausalType;
  readonly confidence: number;
  readonly rationale: string;
}

/** 嵌套时的一个子模块结论。 */
export interface SubModuleClassification {
  readonly name: string;
  readonly classification: CausalClassification;
}

/** 分类器的唯一输出结构。 */
export interface CausalClassification {
  readonly causal_type: CausalType;
  /** 已归一到 [0, CONFIDENCE_CEILING]，恒不等于 1.0。 */
  readonly confidence: number;
  /** 恒非空：unknown 也要给出"为什么判不出来"的证据。 */
  readonly evidence: readonly Evidence[];
  /** 仅 causal_type==='nested' 时出现；无法拆分时为空数组。 */
  readonly sub_modules?: readonly SubModuleClassification[];
  /** 规则轨迹，用于审计与回退定位。 */
  readonly judgment_basis: readonly JudgmentBasis[];
  /** confidence < EXPLORATION_THRESHOLD 时为 true。 */
  readonly needs_exploration: boolean;
  /** 进入探索模式的原因；仅 needs_exploration=true 时出现。 */
  readonly exploration_reason?: string;
  /** 仅 unknown 时出现：候选假设，按置信度降序。 */
  readonly candidate_hypotheses?: readonly CandidateHypothesis[];
}