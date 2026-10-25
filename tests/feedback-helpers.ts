/**
 * clis-feedback 独立黑盒验收套件的共享工具。
 *
 * 纪律：一切期望值只来自 `docs/SPEC-feedback.md`（冻结规格）与 `@clis/clis-contracts`，
 * 绝不从 `packages/clis-feedback/src/**` 反推。
 * （唯一例外：`feedback-static.test.ts` 依 SPEC §6-4 读源码文本做静态断言。）
 *
 * 本文件刻意**不** import `@clis/clis-feedback`，故障面被限制在测试文件内。
 */
import { expect } from 'vitest';

import {
  CAUSAL_TYPES,
  FEEDBACK_SIGNAL_TYPES,
  KNOWN_CAUSAL_TYPES,
  ROLLBACK_KINDS,
} from '@clis/clis-contracts';
import type {
  BlockedAction,
  CausalClassificationRef,
  CausalType,
  DetectOptions,
  ExecutionResult,
  ExecutionSignal,
  ExecutionSignalKind,
  ExecutionStatus,
  FeedbackBoundary,
  FeedbackHistory,
  FeedbackRequest,
  FeedbackSignal,
  FeedbackSignalType,
} from '@clis/clis-contracts';

export const HISTORICAL_DEVIATIONS: readonly FeedbackSignalType[] = ['ineffective'];

/** SPEC §3.4 模式标记词（大小写敏感）。 */
export const MODE_MARKERS = {
  unilateral_definition_change: 'unilateral_definition_change',
  feedback_introduced: 'feedback_introduced',
  worsened: 'worsened',
} as const;

export function fbBoundary(overrides: Partial<FeedbackBoundary> = {}): FeedbackBoundary {
  return { forbidden_actions: [], ...overrides };
}

export function classificationRef(
  causalType: CausalType,
  confidence = 0.9,
  extra: Partial<CausalClassificationRef> = {},
): CausalClassificationRef {
  return { causal_type: causalType, confidence, ...extra };
}

export function history(
  previous: readonly FeedbackSignalType[] = [],
  extra: Partial<FeedbackHistory> = {},
): FeedbackHistory {
  return { previous_signals: previous, ...extra };
}

export function detectOptions(previous: readonly FeedbackSignalType[] = []): DetectOptions {
  return { history: history(previous) };
}

// —— ExecutionResult 构造器（输入是数据，可精确到每一步的信号与 detail） ——

export function signalAt(
  stepIndex: number,
  action: string,
  kind: ExecutionSignalKind,
  detail: string,
  pathId = 'p1',
): ExecutionSignal {
  return { path_id: pathId, step_index: stepIndex, action, kind, detail };
}

export function observedAt(
  stepIndex: number,
  action: string,
  detail = '执行器回执：ok',
  pathId = 'p1',
): ExecutionSignal {
  return signalAt(stepIndex, action, 'observed', detail, pathId);
}

export function summaryAt(pathId: string, detail = '共 1 步，最终状态 succeeded'): ExecutionSignal {
  return signalAt(-1, 'summary', 'summary', detail, pathId);
}

export interface ResultInit {
  readonly status: ExecutionStatus;
  readonly signals?: readonly ExecutionSignal[];
  readonly blocked_actions?: readonly BlockedAction[];
  readonly path_id?: string;
  readonly sub_results?: readonly ExecutionResult[];
}

/** 构造一个结构合法的 ExecutionResult；缺省给一条 observed + 一条 summary。 */
export function makeResult(init: ResultInit): ExecutionResult {
  const pathId = init.path_id ?? 'p1';
  const result: ExecutionResult = {
    path_id: pathId,
    status: init.status,
    signals: init.signals ?? [observedAt(0, 'act', '执行器回执：ok', pathId), summaryAt(pathId)],
    blocked_actions: init.blocked_actions ?? [],
  };
  if (init.sub_results !== undefined) {
    return { ...result, sub_results: init.sub_results };
  }
  return result;
}

/** 成功且有 2 步 ok 的结果。 */
export function succeededResult(): ExecutionResult {
  return makeResult({
    status: 'succeeded',
    signals: [
      observedAt(0, 'step_a', '执行器回执#1'),
      observedAt(1, 'step_b', '执行器回执#2'),
      summaryAt('p1'),
    ],
  });
}

/** 失败结果，detail 可携带模式标记词。 */
export function failedResult(detail = '执行器报错：偏离预期'): ExecutionResult {
  return makeResult({
    status: 'failed',
    signals: [
      observedAt(0, 'step_a', '执行器回执#1'),
      signalAt(1, 'step_b', 'failed', detail),
      summaryAt('p1'),
    ],
  });
}

export function blockedResult(): ExecutionResult {
  return makeResult({
    status: 'blocked',
    signals: [signalAt(0, 'step_a', 'skipped_forbidden', '越界被拦'), summaryAt('p1')],
    blocked_actions: [{ action: 'step_a', reason: 'forbidden' }],
  });
}

export function request(
  result: ExecutionResult,
  assumedType: CausalType,
  overrides: Partial<FeedbackRequest> = {},
): FeedbackRequest {
  return {
    result,
    classification: classificationRef(assumedType),
    boundary: fbBoundary(),
    ...overrides,
  };
}

// —— 断言助手 ——

/** 表示"已执行回退"的字段名（SPEC §1/§4）。 */
export const EXECUTED_KEY_NAMES: readonly string[] = ['executed', 'applied', 'rollback_performed'];

export function collectKeys(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
  return out;
}

/** SPEC §4 输出不变量（与具体预期无关的部分）。 */
export function signalViolations(signal: FeedbackSignal, label: string): string[] {
  const bad: string[] = [];
  if (typeof signal.reason !== 'string' || signal.reason.length === 0) {
    bad.push(`${label}: reason 恒非空`);
  }
  if (!Array.isArray(signal.evidence) || signal.evidence.length === 0) {
    bad.push(`${label}: evidence 恒非空`);
  } else {
    signal.evidence.forEach((item, index) => {
      if (typeof item.statement !== 'string' || item.statement.length === 0) {
        bad.push(`${label}: evidence[${index}].statement 必须非空`);
      }
      if (typeof item.rule_id !== 'string' || item.rule_id.length === 0) {
        bad.push(`${label}: evidence[${index}].rule_id 必须非空`);
      }
    });
  }
  if (!(FEEDBACK_SIGNAL_TYPES as readonly string[]).includes(signal.signal_type)) {
    bad.push(`${label}: signal_type 非法 ${String(signal.signal_type)}`);
  }
  if (!(CAUSAL_TYPES as readonly string[]).includes(signal.assumed_type)) {
    bad.push(`${label}: assumed_type 非法 ${String(signal.assumed_type)}`);
  }
  const hasRollback = Object.prototype.hasOwnProperty.call(signal, 'suggested_rollback');
  if (signal.signal_type === 'type_misjudged') {
    if (!hasRollback || signal.suggested_rollback === undefined) {
      bad.push(`${label}: type_misjudged 必须带 suggested_rollback`);
    }
  } else if (hasRollback) {
    bad.push(`${label}: 非 type_misjudged 不得存在 suggested_rollback 字段`);
  }
  if (signal.suggested_rollback !== undefined) {
    const rollback = signal.suggested_rollback;
    if (!(ROLLBACK_KINDS as readonly string[]).includes(rollback.kind)) {
      bad.push(`${label}: rollback.kind 非法 ${String(rollback.kind)}`);
    }
    if (!(KNOWN_CAUSAL_TYPES as readonly string[]).includes(rollback.target_type)) {
      bad.push(`${label}: rollback.target_type 必须在 KNOWN_CAUSAL_TYPES 内`);
    }
    if (typeof rollback.rationale !== 'string' || rollback.rationale.length === 0) {
      bad.push(`${label}: rollback.rationale 必须非空`);
    } else if (rollback.rationale.length > 120) {
      bad.push(`${label}: rollback.rationale 必须 ≤120 字，实际 ${rollback.rationale.length}`);
    }
  }
  for (const key of collectKeys(signal)) {
    if (EXECUTED_KEY_NAMES.includes(key)) {
      bad.push(`${label}: 输出不得含"已执行"字段 ${key}`);
    }
  }
  return bad;
}

export function expectSignalInvariants(signal: FeedbackSignal, label = ''): void {
  expect(signalViolations(signal, label)).toStrictEqual([]);
}

/** 证据里必须包含触发该结论的规则 id（SPEC §4）。 */
export function evidenceRuleIds(signal: FeedbackSignal): string[] {
  return signal.evidence.map((item) => item.rule_id);
}

export function expectEvidenceContainsRule(signal: FeedbackSignal, ruleId: string): void {
  expect(evidenceRuleIds(signal)).toContain(ruleId);
}

/** 深快照比对：detectSignal 必须是纯函数（不改入参）。 */
export function expectPureCall(
  run: (request: FeedbackRequest, options?: DetectOptions) => unknown,
  req: FeedbackRequest,
  opts?: DetectOptions,
): void {
  const requestSnapshot = structuredClone(req);
  const optionsSnapshot = opts === undefined ? undefined : structuredClone(opts);
  run(req, opts);
  expect(req).toStrictEqual(requestSnapshot);
  if (opts !== undefined) expect(opts).toStrictEqual(optionsSnapshot);
}