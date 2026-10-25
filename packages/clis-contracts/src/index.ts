/**
 * @clis/clis-contracts —— CLIS 共享契约包。
 *
 * 唯一职责：定义类型、四问、输出结构与抽象服务接口。
 * 不含任何判定逻辑、策略逻辑或反馈逻辑；不 import 任何 CLIS 插件实现。
 */

export {
  CAUSAL_TYPES,
  KNOWN_CAUSAL_TYPES,
  isCausalType,
  isKnownCausalType,
} from './causal-type';
export type { CausalType, KnownCausalType } from './causal-type';

export {
  TRI_STATES,
  FOUR_QUESTIONS,
  ANSWER_KEYS,
  isTriState,
} from './questions';
export type {
  TriState,
  QuestionId,
  AnswerKey,
  FourAnswers,
  QuestionSpec,
} from './questions';

export {
  CONFIDENCE_CEILING,
  EXPLORATION_THRESHOLD,
  DEFAULT_MAX_DEPTH,
  MAX_DEPTH_LIMIT,
  ROLLBACK_LIMIT,
  TYPE_LOCK_ROUNDS,
  normalizeConfidence,
} from './limits';

export type {
  Evidence,
  EvidenceSource,
  JudgmentBasis,
  CandidateHypothesis,
  SubModuleClassification,
  CausalClassification,
} from './classification';

export type { CausalProblem, ClassifyOptions } from './problem';

export { ClisContractError } from './errors';
export type { ClisContractErrorCode, ClisContractErrorDetail } from './errors';

export { CAUSAL_CLASSIFIER_SERVICE } from './service';
export type { CausalClassifierService } from './service';