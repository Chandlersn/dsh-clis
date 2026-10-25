/**
 * @clis/clis-contracts —— CLIS 共享契约包。
 *
 * 唯一职责：定义类型、四问、输出结构、排序公式与抽象服务接口。
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
  normalizeScore,
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

export { blockedReason } from './boundary';
export type { StrategyBoundary, BlockedAction, BlockedActionReason } from './boundary';

export {
  STRATEGY_FAMILIES,
  FAMILY_BY_TYPE,
  PROBE_FAMILY,
  PATH_VARIANTS,
  PATH_SCORE_WEIGHTS,
  scorePath,
  ACTION_RESULT_STATUSES,
  EXECUTION_SIGNAL_KINDS,
  EXECUTION_STATUSES,
} from './strategy';
export type {
  StrategyFamily,
  PathVariantId,
  PathScoreComponents,
  PathStep,
  CandidatePath,
  StrategyMatchOptions,
  ActionInvocation,
  ActionResult,
  ActionResultStatus,
  ActionExecutor,
  ExecutionSignal,
  ExecutionSignalKind,
  ExecutionResult,
  ExecutionStatus,
  ExecutePathOptions,
} from './strategy';

export {
  FEEDBACK_SIGNAL_TYPES,
  ROLLBACK_KINDS,
} from './feedback';
export type {
  FeedbackSignalType,
  RollbackKind,
  SuggestedRollback,
  FeedbackEvidence,
  FeedbackSignal,
  FeedbackRequest,
  CausalClassificationRef,
  FeedbackBoundary,
  FeedbackHistory,
  DetectOptions,
} from './feedback';

export { ClisContractError } from './errors';
export type { ClisContractErrorCode, ClisContractErrorDetail } from './errors';

export {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
} from './service';
export type { CausalClassifierService, StrategyService, FeedbackService } from './service';