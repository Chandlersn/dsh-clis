import { ClisContractError, FEEDBACK_SIGNAL_TYPES, isCausalType } from '@clis/clis-contracts';
import type {
  CausalClassificationRef,
  ClisContractErrorCode,
  ClisContractErrorDetail,
  DetectOptions,
  FeedbackEvidence,
  FeedbackHistory,
  FeedbackRequest,
  FeedbackSignal,
  FeedbackSignalType,
  KnownCausalType,
  RollbackKind,
  SuggestedRollback,
} from '@clis/clis-contracts';

/**
 * 反馈判据的唯一实现。
 *
 * 只读执行结果与类型假设，**不调用 classifier、不执行回退、不改系统状态**。
 */

/** 判据版本：任何规则变动都必须同时提升它。 */
export const FEEDBACK_RULES_VERSION = '1.0.0';

/** 缺省允许的连续干预轮数上限。 */
const DEFAULT_MAX_ROUNDS = 3;

/** 模式信号标记词（出现在执行器 detail 中）。 */
const PATTERN_UNILATERAL = 'unilateral_definition_change';
const PATTERN_FEEDBACK_INTRODUCED = 'feedback_introduced';
const PATTERN_WORSENED = 'worsened';

/** 偏离是否已"反复"：历史里已有 ≥1 次 ineffective 或 type_misjudged。 */
const REPEATED_DEVIATION_THRESHOLD = 1;

interface RuleOutcome {
  readonly signal_type: FeedbackSignalType;
  readonly reason: string;
  readonly evidence: FeedbackEvidence[];
  readonly rollback?: SuggestedRollback;
}

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

function assertResult(value: unknown, path: string): void {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_RESULT', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  if (value.status !== 'succeeded' && value.status !== 'failed' && value.status !== 'blocked') {
    details.push({
      path: `${path}.status`,
      expected: "'succeeded' | 'failed' | 'blocked'",
      received: describeReceived(value.status),
    });
  }

  if (!Array.isArray(value.signals)) {
    details.push({
      path: `${path}.signals`,
      expected: 'array',
      received: describeReceived(value.signals),
    });
  } else {
    value.signals.forEach((item, index) => {
      if (!isPlainObject(item)) {
        details.push({
          path: `${path}.signals[${index}]`,
          expected: 'object',
          received: describeReceived(item),
        });
        return;
      }
      if (typeof item.kind !== 'string') {
        details.push({
          path: `${path}.signals[${index}].kind`,
          expected: 'string',
          received: describeReceived(item.kind),
        });
      }
      if (typeof item.detail !== 'string') {
        details.push({
          path: `${path}.signals[${index}].detail`,
          expected: 'string',
          received: describeReceived(item.detail),
        });
      }
    });
  }

  if (value.blocked_actions !== undefined && !Array.isArray(value.blocked_actions)) {
    details.push({
      path: `${path}.blocked_actions`,
      expected: 'array | undefined',
      received: describeReceived(value.blocked_actions),
    });
  }

  if (details.length > 0) fail('INVALID_RESULT', `${path} 不是合法的执行结果`, details);
}

function assertClassificationRef(value: unknown, path: string): void {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_CLASSIFICATION', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  if (!isCausalType(value.causal_type)) {
    details.push({
      path: `${path}.causal_type`,
      expected: 'CausalType',
      received: describeReceived(value.causal_type),
    });
  }

  if (details.length > 0) fail('INVALID_CLASSIFICATION', `${path} 不是合法的类型假设`, details);
}

function assertBoundary(value: unknown, path: string): void {
  const details: ClisContractErrorDetail[] = [];

  if (!isPlainObject(value)) {
    fail('INVALID_BOUNDARY', `${path} 必须是对象`, [
      { path, expected: 'object', received: describeReceived(value) },
    ]);
  }

  if (!Array.isArray(value.forbidden_actions)) {
    details.push({
      path: `${path}.forbidden_actions`,
      expected: 'string[]',
      received: describeReceived(value.forbidden_actions),
    });
  }

  const maxRounds = value.max_rounds;
  if (
    maxRounds !== undefined &&
    (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 0)
  ) {
    details.push({
      path: `${path}.max_rounds`,
      expected: 'non-negative integer | undefined',
      received: describeReceived(maxRounds),
    });
  }

  if (details.length > 0) fail('INVALID_BOUNDARY', `${path} 不是合法的边界`, details);
}

function resolveHistory(options: DetectOptions | undefined): FeedbackHistory {
  if (options === undefined) return { previous_signals: [] };

  if (!isPlainObject(options)) {
    fail('INVALID_OPTIONS', 'options 必须是对象', [
      { path: 'options', expected: 'object', received: describeReceived(options) },
    ]);
  }

  const history = options.history;
  if (history === undefined) return { previous_signals: [] };

  if (!isPlainObject(history)) {
    fail('INVALID_OPTIONS', 'options.history 必须是对象', [
      { path: 'options.history', expected: 'object', received: describeReceived(history) },
    ]);
  }

  const previous = history.previous_signals;
  const details: ClisContractErrorDetail[] = [];

  if (previous !== undefined) {
    if (!Array.isArray(previous)) {
      details.push({
        path: 'options.history.previous_signals',
        expected: 'FeedbackSignalType[] | undefined',
        received: describeReceived(previous),
      });
    } else {
      previous.forEach((item, index) => {
        if (!(FEEDBACK_SIGNAL_TYPES as readonly string[]).includes(item as string)) {
          details.push({
            path: `options.history.previous_signals[${index}]`,
            expected: 'FeedbackSignalType',
            received: describeReceived(item),
          });
        }
      });
    }
  }

  if (details.length > 0) fail('INVALID_OPTIONS', 'options.history 不合法', details);

  const rollbackCount = history.rollback_count;
  if (
    rollbackCount !== undefined &&
    (typeof rollbackCount !== 'number' || !Number.isInteger(rollbackCount) || rollbackCount < 0)
  ) {
    fail('INVALID_OPTIONS', 'options.history.rollback_count 必须是非负整数', [
      {
        path: 'options.history.rollback_count',
        expected: 'non-negative integer | undefined',
        received: describeReceived(rollbackCount),
      },
    ]);
  }

  const base: FeedbackHistory = {
    previous_signals: (previous ?? []) as readonly FeedbackSignalType[],
  };

  return rollbackCount === undefined ? base : { ...base, rollback_count: rollbackCount };
}

function signalDetails(result: FeedbackRequest['result']): readonly string[] {
  return result.signals.map((item) => item.detail);
}

function hasPattern(result: FeedbackRequest['result'], marker: string): boolean {
  return signalDetails(result).some((detail) => detail.includes(marker));
}

function repeatedDeviation(history: FeedbackHistory): boolean {
  const count = history.previous_signals.filter(
    (item) => item === 'ineffective' || item === 'type_misjudged',
  ).length;
  return count >= REPEATED_DEVIATION_THRESHOLD;
}

function rollback(
  kind: RollbackKind,
  target: KnownCausalType,
  rationale: string,
): SuggestedRollback {
  return { kind, target_type: target, rationale };
}

function evidence(ruleId: string, statement: string): FeedbackEvidence {
  return { rule_id: ruleId, statement };
}

/** §3.1 boundary_invalid（最高优先级）。 */
function detectBoundaryInvalid(
  request: FeedbackRequest,
  history: FeedbackHistory,
): RuleOutcome | null {
  const { result, boundary } = request;
  const maxRounds = boundary.max_rounds ?? DEFAULT_MAX_ROUNDS;
  const ineffectiveCount = history.previous_signals.filter((item) => item === 'ineffective').length;

  if (ineffectiveCount >= maxRounds) {
    return {
      signal_type: 'boundary_invalid',
      reason: `连续无效干预已达 ${ineffectiveCount} 次，超过预设上限 ${maxRounds} 次，继续加码已越界`,
      evidence: [
        evidence(
          'B1',
          `历史 ineffective 计数 ${ineffectiveCount} ≥ max_rounds ${maxRounds}`,
        ),
      ],
    };
  }

  const blocked = result.blocked_actions ?? [];
  if (blocked.length > 0) {
    return {
      signal_type: 'boundary_invalid',
      reason: `执行期发生 ${blocked.length} 次边界拦截，优化已越出预设边界`,
      evidence: [
        evidence('B2', `blocked_actions 非空：${blocked.map((item) => item.action).join('、')}`),
      ],
    };
  }

  if (result.status === 'blocked') {
    return {
      signal_type: 'boundary_invalid',
      reason: '整条路径因越界被阻断，未执行任何步骤',
      evidence: [evidence('B3', 'result.status === "blocked"')],
    };
  }

  return null;
}

/** §3.2 type_misjudged（M1–M4）。 */
function detectTypeMisjudged(
  request: FeedbackRequest,
  history: FeedbackHistory,
): RuleOutcome | null {
  const { result, classification } = request;
  const assumed = classification.causal_type;

  if (!repeatedDeviation(history)) return null;

  const repeatedNote = `历史已出现反复偏离（${history.previous_signals.join('、')}）`;

  if (assumed === 'unidirectional' && result.status !== 'succeeded') {
    return {
      signal_type: 'type_misjudged',
      reason:
        '假设为单向因果，但干预无效且问题反复：单向因果下干预应产生方向明确的一次性效果，反复无效与"严格先后"假设矛盾',
      evidence: [
        evidence('M1', `assumed=unidirectional，status=${result.status}`),
        evidence('M1', repeatedNote),
      ],
      rollback: rollback(
        'recheck_type',
        'cyclic',
        '反复无效更像存在回路：建议回退检查循环因果',
      ),
    };
  }

  if (assumed === 'cyclic' && result.status === 'failed') {
    return {
      signal_type: 'type_misjudged',
      reason:
        '假设为循环因果，但越干预越糟：回路干预通常会先振荡后收敛，单向恶化更符合单向因果的不可逆特性',
      evidence: [
        evidence('M2', `assumed=cyclic，status=failed`),
        evidence('M2', hasPattern(result, PATTERN_WORSENED) ? `命中标记 ${PATTERN_WORSENED}` : repeatedNote),
      ],
      rollback: rollback(
        'recheck_type',
        'unidirectional',
        '单向恶化更像不可逆的单向因果：建议回退检查单向因果',
      ),
    };
  }

  if (assumed === 'structural_duality' && hasPattern(result, PATTERN_UNILATERAL)) {
    return {
      signal_type: 'type_misjudged',
      reason:
        '假设为结构对偶，但检测到一方单方面改定义：对偶要求两极同时成立、彼此定义，单边改动已破坏该前提',
      evidence: [
        evidence('M3', `assumed=structural_duality，命中标记 ${PATTERN_UNILATERAL}`),
        evidence('M3', repeatedNote),
      ],
      rollback: rollback(
        'recheck_type',
        'unidirectional',
        '单边改定义更像有先后的单向作用：建议回退检查单向因果',
      ),
    };
  }

  if (
    assumed === 'structural_duality' &&
    hasPattern(result, PATTERN_FEEDBACK_INTRODUCED) &&
    result.status === 'failed'
  ) {
    return {
      signal_type: 'type_misjudged',
      reason:
        '假设为结构对偶，但强行引入反馈后失稳：对偶本身无时间先后，引入反馈等于错误地加了回路',
      evidence: [
        evidence('M4', `assumed=structural_duality，命中标记 ${PATTERN_FEEDBACK_INTRODUCED}`),
        evidence('M4', `status=failed`),
      ],
      rollback: rollback(
        'restore_type',
        'structural_duality',
        '撤销这次误加的反馈，回到结构对偶假设',
      ),
    };
  }

  return null;
}

/** §3.4 effective。 */
function detectEffective(request: FeedbackRequest): RuleOutcome | null {
  const { result, boundary } = request;
  if (result.status !== 'succeeded') return null;

  const requireAllOk = boundary.require_all_ok !== false;
  if (requireAllOk) {
    const stepSignals = result.signals.filter((item) => item.step_index >= 0);
    const notOk = stepSignals.filter((item) => item.kind !== 'observed');
    if (notOk.length > 0) {
      return null;
    }
    return {
      signal_type: 'effective',
      reason: '结果符合成功标准：全部步骤均成功执行',
      evidence: [
        evidence('E1', `status=succeeded，${stepSignals.length} 个步骤全部 observed`),
      ],
    };
  }

  return {
    signal_type: 'effective',
    reason: '结果符合成功标准：执行状态为 succeeded（调用方已放宽逐步校验）',
    evidence: [evidence('E2', 'status=succeeded 且 require_all_ok=false')],
  };
}

/**
 * 检测反馈信号 —— 纯函数：同步、确定性、无 I/O。
 *
 * 不重新判断因果类型、不执行回退、不修改任何系统状态。
 *
 * @param request — 执行结果 + 类型假设（只读）+ 边界。
 * @param options — 历史轨迹。
 * @returns 反馈信号。
 */
export function detectSignal(
  request: FeedbackRequest,
  options?: DetectOptions,
): FeedbackSignal {
  if (!isPlainObject(request)) {
    fail('INVALID_RESULT', 'request 必须是对象', [
      { path: 'request', expected: 'object', received: describeReceived(request) },
    ]);
  }

  assertResult(request.result, 'request.result');
  assertClassificationRef(request.classification, 'request.classification');
  assertBoundary(request.boundary, 'request.boundary');

  const history = resolveHistory(options);

  const outcome =
    detectBoundaryInvalid(request, history) ??
    detectTypeMisjudged(request, history) ??
    detectEffective(request) ?? {
      signal_type: 'ineffective' as const,
      reason: `结果偏离但类型假设仍成立：status=${request.result.status}`,
      evidence: [
        evidence(
          'I1',
          `status=${request.result.status}；未命中边界越界或类型误判规则`,
        ),
      ],
    };

  const draft: {
    signal_type: FeedbackSignalType;
    reason: string;
    evidence: FeedbackEvidence[];
    assumed_type: CausalClassificationRef['causal_type'];
    suggested_rollback?: SuggestedRollback;
  } = {
    signal_type: outcome.signal_type,
    reason: outcome.reason,
    evidence: outcome.evidence,
    assumed_type: request.classification.causal_type,
  };

  // 回退建议只在 type_misjudged 时出现；其余情况字段不存在（不是 null）。
  if (outcome.rollback !== undefined) draft.suggested_rollback = outcome.rollback;

  return draft;
}