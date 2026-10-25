import type {
  CandidatePath,
  ExecutionResult,
  ExecutionSignal,
  FeedbackSignal,
  FeedbackSignalType,
  OrchestratorRound,
  OrchestratorState,
  SuggestedRollback,
} from '@clis/clis-contracts';
import { initialState } from '@clis/clis-contracts';

export function path(pathId = 'p1'): CandidatePath {
  return {
    path_id: pathId,
    variant: 'probe.minimal',
    variant_version: '1.0.0',
    library_version: '1.0.0',
    family: 'probe_and_observe',
    causal_type: 'cyclic',
    steps: [{ index: 0, action: 'probe_environment', params: {}, rationale: '探测' }],
    blocked_actions: [],
    executable: true,
    components: { type_fit: 1, expected_effect: 1, side_effect_risk: 0, execution_cost: 0 },
    score: 1,
    rank: 1,
    summary: '探测路径',
  };
}

export function execution(status: ExecutionResult['status']): ExecutionResult {
  const signals: ExecutionSignal[] = [
    { path_id: 'p1', step_index: 0, action: 'probe_environment', kind: 'observed', detail: '完成' },
    { path_id: 'p1', step_index: -1, action: 'summary', kind: 'summary', detail: `状态 ${status}` },
  ];
  return { path_id: 'p1', status, signals, blocked_actions: [] };
}

export function signal(
  signalType: FeedbackSignalType,
  rollbackTarget?: SuggestedRollback,
): FeedbackSignal {
  const base: {
    signal_type: FeedbackSignalType;
    reason: string;
    evidence: { rule_id: string; statement: string }[];
    assumed_type: 'cyclic';
    suggested_rollback?: SuggestedRollback;
  } = {
    signal_type: signalType,
    reason: `测试信号 ${signalType}`,
    evidence: [{ rule_id: 'T1', statement: '测试证据' }],
    assumed_type: 'cyclic',
  };
  if (rollbackTarget !== undefined) base.suggested_rollback = rollbackTarget;
  return base;
}

export function round(
  signalType: FeedbackSignalType,
  options: {
    status?: ExecutionResult['status'];
    rollback?: SuggestedRollback;
    causalType?: OrchestratorRound['causal_type'];
  } = {},
): OrchestratorRound {
  const causalType = options.causalType ?? 'cyclic';
  const status =
    options.status ??
    (signalType === 'effective'
      ? 'succeeded'
      : signalType === 'boundary_invalid'
        ? 'blocked'
        : 'failed');

  return {
    problem: {
      description: '测试问题',
      answers: {
        q1_simultaneous_mutual_definition: 'no',
        q2_delayed_mutual_influence: 'yes',
        q3_strict_irreversible_order: 'no',
        q4_coexisting_causal_structures: 'no',
      },
    },
    boundary: { forbidden_actions: [] },
    path: path(),
    execution: execution(status),
    signal: signal(signalType, options.rollback),
    causal_type: causalType,
  };
}

export function state(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return { ...initialState(), ...overrides };
}

export const ROLLBACK_TO_CYCLIC: SuggestedRollback = {
  kind: 'recheck_type',
  target_type: 'cyclic',
  rationale: '建议回退检查循环因果',
};