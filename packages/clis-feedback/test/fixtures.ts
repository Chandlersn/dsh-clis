import type {
  CausalClassificationRef,
  ExecutionResult,
  ExecutionSignal,
  ExecutionSignalKind,
  ExecutionStatus,
  FeedbackBoundary,
  FeedbackRequest,
  FeedbackSignalType,
} from '@clis/clis-contracts';

/** 造一条执行信号。 */
export function sig(
  kind: ExecutionSignalKind,
  detail: string,
  stepIndex = 0,
  action = 'act',
): ExecutionSignal {
  return { path_id: 'p1', step_index: stepIndex, action, kind, detail };
}

/** 造一个执行结果；缺省成功、无阻断。 */
export function result(
  status: ExecutionStatus,
  signals: readonly ExecutionSignal[] = [sig('observed', '完成'), sig('summary', '1 步，状态 succeeded', -1, 'summary')],
  blocked: ExecutionResult['blocked_actions'] = [],
): ExecutionResult {
  return { path_id: 'p1', status, signals, blocked_actions: blocked };
}

export function classification(causalType: CausalClassificationRef['causal_type']): CausalClassificationRef {
  return { causal_type: causalType, confidence: 0.9 };
}

export function boundary(extra: Partial<FeedbackBoundary> = {}): FeedbackBoundary {
  return { forbidden_actions: [], ...extra };
}

export function request(
  res: ExecutionResult,
  type: CausalClassificationRef['causal_type'],
  bnd: FeedbackBoundary = boundary(),
): FeedbackRequest {
  return { result: res, classification: classification(type), boundary: bnd };
}

/** 历史里已有反复偏离 —— 判定 type_misjudged 的前置条件。 */
export function repeatedHistory(...extra: FeedbackSignalType[]): { previous_signals: FeedbackSignalType[] } {
  return { previous_signals: ['ineffective', ...extra] };
}

export function emptyHistory(): { previous_signals: FeedbackSignalType[] } {
  return { previous_signals: [] };
}