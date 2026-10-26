import {
  ClisContractError,
  ROLLBACK_LIMIT,
  TYPE_LOCK_ROUNDS,
  initialState,
} from '@clis/clis-contracts';
import type {
  ClisContractErrorCode,
  ClisContractErrorDetail,
  OrchestratorAction,
  OrchestratorDecision,
  OrchestratorOptions,
  OrchestratorRound,
  OrchestratorState,
  RoundTrace,
} from '@clis/clis-contracts';

/**
 * 编排决策的唯一实现。
 *
 * 只依据"本轮信号类型 + 当前状态"决定下一步；不含任何因果判据、策略规则或反馈规则 ——
 * 那三件事分别由另外三个插件通过服务接口提供。
 */

/** 回退次数上限缺省值。 */
export const ROLLBACK_LIMIT_DEFAULT = ROLLBACK_LIMIT;

/** 震荡锁定时长缺省值（轮）。 */
export const TYPE_LOCK_ROUNDS_DEFAULT = TYPE_LOCK_ROUNDS;

/** 同一类型连续被回退达到此数即触发锁定。 */
const LOCK_TRIGGER_THRESHOLD = 2;

/** 未解决信号：达到回退上限后仍出现这些信号 ⇒ 需人工介入。 */
const UNRESOLVED_SIGNALS = ['type_misjudged', 'ineffective', 'boundary_invalid'] as const;

function fail(
  code: ClisContractErrorCode,
  message: string,
  details: readonly ClisContractErrorDetail[],
): never {
  throw new ClisContractError(code, message, details);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeReceived(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  const kind = typeof value;
  if (kind === 'string') {
    const text = value as string;
    return `string(${text.length <= 40 ? JSON.stringify(text) : `${JSON.stringify(text.slice(0, 40))}…`})`;
  }
  if (kind === 'object') return 'object';
  return `${kind}(${String(value)})`;
}

function assertState(value: unknown, path: string): asserts value is OrchestratorState {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_STATE', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  if (typeof value.round !== 'number' || !Number.isInteger(value.round) || value.round < 0) {
    details.push({
      path: `${path}.round`,
      expected: 'non-negative integer',
      received: describeReceived(value.round),
    });
  }

  if (
    typeof value.rollback_count !== 'number' ||
    !Number.isInteger(value.rollback_count) ||
    value.rollback_count < 0
  ) {
    details.push({
      path: `${path}.rollback_count`,
      expected: 'non-negative integer',
      received: describeReceived(value.rollback_count),
    });
  }

  if (!Array.isArray(value.traces)) {
    details.push({
      path: `${path}.traces`,
      expected: 'array',
      received: describeReceived(value.traces),
    });
  }

  if (!isPlainObject(value.oscillation)) {
    details.push({
      path: `${path}.oscillation`,
      expected: 'object',
      received: describeReceived(value.oscillation),
    });
  }

  if (details.length > 0) fail('INVALID_STATE', `${path} 不是合法的编排状态`, details);
}

function assertRound(value: unknown, path: string): asserts value is OrchestratorRound {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_RESULT', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  if (!isPlainObject(value.execution)) {
    details.push({
      path: `${path}.execution`,
      expected: 'object',
      received: describeReceived(value.execution),
    });
  }

  if (!isPlainObject(value.signal)) {
    details.push({
      path: `${path}.signal`,
      expected: 'object',
      received: describeReceived(value.signal),
    });
  }

  if (!isPlainObject(value.path)) {
    details.push({
      path: `${path}.path`,
      expected: 'object',
      received: describeReceived(value.path),
    });
  }

  if (details.length > 0) fail('INVALID_RESULT', `${path} 不是合法的一轮输入`, details);
}

function resolveOptions(options: OrchestratorOptions | undefined): {
  rollbackLimit: number;
  lockRounds: number;
} {
  if (options === undefined) {
    return { rollbackLimit: ROLLBACK_LIMIT_DEFAULT, lockRounds: TYPE_LOCK_ROUNDS_DEFAULT };
  }

  if (!isPlainObject(options)) {
    fail('INVALID_OPTIONS', 'options 必须是对象', [
      { path: 'options', expected: 'object', received: describeReceived(options) },
    ]);
  }

  const limit = options.rollback_limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
    fail('INVALID_OPTIONS', 'options.rollback_limit 必须是正整数', [
      {
        path: 'options.rollback_limit',
        expected: 'positive integer | undefined',
        received: describeReceived(limit),
      },
    ]);
  }

  const lock = options.lock_rounds;
  if (lock !== undefined && (typeof lock !== 'number' || !Number.isInteger(lock) || lock < 0)) {
    fail('INVALID_OPTIONS', 'options.lock_rounds 必须是非负整数', [
      {
        path: 'options.lock_rounds',
        expected: 'non-negative integer | undefined',
        received: describeReceived(lock),
      },
    ]);
  }

  return {
    rollbackLimit: limit ?? ROLLBACK_LIMIT_DEFAULT,
    lockRounds: lock ?? TYPE_LOCK_ROUNDS_DEFAULT,
  };
}

function bumpCounts(
  counts: Readonly<Record<string, number>>,
  causalType: string,
): Record<string, number> {
  return { ...counts, [causalType]: (counts[causalType] ?? 0) + 1 };
}

function resetCount(
  counts: Readonly<Record<string, number>>,
  causalType: string,
): Record<string, number> {
  const next = { ...counts };
  delete next[causalType];
  return next;
}

function buildTrace(
  round: OrchestratorRound,
  roundNumber: number,
  action: OrchestratorAction,
  rollbackCount: number,
  note: string,
): RoundTrace {
  return {
    round: roundNumber,
    causal_type: round.causal_type,
    path_id: round.path.path_id,
    execution_status: round.execution.status,
    signal_type: round.signal.signal_type,
    action,
    rollback_count: rollbackCount,
    note,
  };
}

interface Draft {
  action: OrchestratorAction;
  reason: string;
  rollbackCount: number;
  retryType?: OrchestratorDecision['retry_type'];
  retryKind?: OrchestratorDecision['retry_kind'];
  nextPathId?: string;
  lockedType?: OrchestratorDecision['locked_type'];
  lockRemaining: number;
  consecutive: Record<string, number>;
}

/**
 * 做出一轮决策 —— 纯函数：同步、确定性、无 I/O、不修改入参。
 *
 * @param round — 本轮输入。
 * @param state — 当前闭环状态。
 * @param options — 回退上限与锁定时长。
 * @returns 决策与更新后的状态（`traces` 只追加、永不丢弃）。
 */
export function decide(
  round: OrchestratorRound,
  state: OrchestratorState,
  options?: OrchestratorOptions,
): { decision: OrchestratorDecision; nextState: OrchestratorState } {
  assertRound(round, 'round');
  assertState(state, 'state');
  const { rollbackLimit, lockRounds } = resolveOptions(options);

  const signalType = round.signal.signal_type;
  const causalType = round.causal_type;
  const roundNumber = state.round + 1;
  const consecutive = state.oscillation.consecutive_rollbacks;
  const unresolved = (UNRESOLVED_SIGNALS as readonly string[]).includes(signalType);

  let draft: Draft;

  // §3.1 回退次数耗尽
  if (state.rollback_count >= rollbackLimit && unresolved) {
    draft = {
      action: 'manual_intervention',
      reason: `回退次数已达上限 ${rollbackLimit} 次且本轮仍未解决（${signalType}）：需人工介入，并已保留完整 trace`,
      rollbackCount: state.rollback_count,
      lockRemaining: state.oscillation.lock_remaining,
      consecutive: { ...consecutive },
    };
  } else if (state.oscillation.lock_remaining > 0 && signalType !== 'effective') {
    // §3.2 锁定生效：不许回退
    draft = {
      action: 'lock_and_continue',
      reason: `类型 ${String(state.oscillation.locked_type)} 处于震荡锁定，还剩 ${state.oscillation.lock_remaining} 轮：本轮锁定继续，不执行回退`,
      rollbackCount: state.rollback_count,
      lockedType: state.oscillation.locked_type,
      lockRemaining: state.oscillation.lock_remaining - 1,
      consecutive: { ...consecutive },
    };
  } else if (signalType === 'boundary_invalid') {
    // §3.3 回退到边界设定
    draft = {
      action: 'rollback_to_boundary',
      reason: '优化已越出预设边界：回退到边界设定，重新界定可行动作范围',
      rollbackCount: state.rollback_count + 1,
      lockRemaining: state.oscillation.lock_remaining,
      consecutive: { ...consecutive },
    };
  } else if (signalType === 'type_misjudged') {
    // §3.4 回退到分类器 + 震荡记录
    const nextConsecutive = bumpCounts(consecutive, causalType);
    const reached = (nextConsecutive[causalType] ?? 0) >= LOCK_TRIGGER_THRESHOLD;

    draft = {
      action: 'rollback_to_classifier',
      reason: `类型假设 ${causalType} 被判定误判：回退到分类器重新判断${reached ? `，并锁定该类型 ${lockRounds} 轮以抑制震荡` : ''}`,
      rollbackCount: state.rollback_count + 1,
      lockRemaining: reached ? lockRounds : state.oscillation.lock_remaining,
      consecutive: nextConsecutive,
    };

    const retry = round.signal.suggested_rollback?.target_type;
    if (retry !== undefined) draft.retryType = retry;
    // §3.4 原样带上建议的种类：feedback 刻意区分 recheck_type（换一种假设）
    // 与 restore_type（回到原类型再试），丢掉它调用方就分辨不了。
    const retryKind = round.signal.suggested_rollback?.kind;
    if (retryKind !== undefined) draft.retryKind = retryKind;
    if (reached) draft.lockedType = causalType;
  } else if (signalType === 'ineffective') {
    // §3.5 换路径
    draft = {
      action: 'switch_path',
      reason: `结果偏离但类型假设仍成立：换一条候选路径重试`,
      rollbackCount: state.rollback_count,
      lockRemaining: state.oscillation.lock_remaining,
      consecutive: { ...consecutive },
    };
    // 契约已声明该字段（早先漏了，实现被迫用 as 断言读未声明属性 ——
// 规格 §3.5 那一条因此在类型层面不可达；2026-10-26 由独立验收方发现）。
    const nextPath = round.next_path_id;
    if (nextPath !== undefined) draft.nextPathId = nextPath;
  } else if (signalType === 'effective') {
    // §3.6 继续 + 清零震荡状态
    draft = {
      action: 'continue',
      reason: '本轮有效：保持当前类型与路径继续推进，并清零震荡计数',
      rollbackCount: state.rollback_count,
      lockRemaining: 0,
      consecutive: resetCount(consecutive, causalType),
    };
  } else {
    // §3.7 兜底
    draft = {
      action: 'continue',
      reason: `信号类型 ${String(signalType)} 未命中任何编排规则：兜底为继续`,
      rollbackCount: state.rollback_count,
      lockRemaining: state.oscillation.lock_remaining,
      consecutive: { ...consecutive },
    };
  }

  const decision: {
    action: OrchestratorAction;
    reason: string;
    rollback_count: number;
    retry_type?: OrchestratorDecision['retry_type'];
    retry_kind?: OrchestratorDecision['retry_kind'];
    next_path_id?: string;
    locked_type?: OrchestratorDecision['locked_type'];
  } = {
    action: draft.action,
    reason: draft.reason,
    rollback_count: draft.rollbackCount,
  };
  if (draft.retryType !== undefined) decision.retry_type = draft.retryType;
  if (draft.retryKind !== undefined) decision.retry_kind = draft.retryKind;
  if (draft.nextPathId !== undefined) decision.next_path_id = draft.nextPathId;
  if (draft.lockedType !== undefined) decision.locked_type = draft.lockedType;

  const trace = buildTrace(round, roundNumber, draft.action, draft.rollbackCount, draft.reason);

  const nextState: OrchestratorState = {
    round: roundNumber,
    rollback_count: draft.rollbackCount,
    oscillation: {
      consecutive_rollbacks: draft.consecutive,
      lock_remaining: draft.lockRemaining,
      ...(draft.lockedType !== undefined ? { locked_type: draft.lockedType } : {}),
    },
    traces: [...state.traces, trace],
  };

  return { decision, nextState };
}

export { initialState };