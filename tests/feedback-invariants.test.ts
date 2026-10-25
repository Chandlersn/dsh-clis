/**
 * SPEC-feedback §4 输出不变量、§6 验证方第 3/5/8 项（回退字段存在性、不执行回退、确定性、纯函数）。
 */
import { describe, expect, it } from 'vitest';

import * as feedbackPlugin from '@clis/clis-feedback';

import {
  EXECUTED_KEY_NAMES,
  MODE_MARKERS,
  blockedResult,
  collectKeys,
  detectOptions,
  expectPureCall,
  expectSignalInvariants,
  failedResult,
  fbBoundary,
  history,
  makeResult,
  observedAt,
  request,
  signalAt,
  signalViolations,
  succeededResult,
  summaryAt,
} from './feedback-helpers';
import type { DetectOptions, FeedbackRequest, FeedbackSignalType } from '@clis/clis-contracts';

const detect = feedbackPlugin.detectSignal;

interface Case {
  readonly name: string;
  readonly req: FeedbackRequest;
  readonly opts?: DetectOptions;
  readonly expected: FeedbackSignalType;
  readonly rule?: string;
}

const cases: readonly Case[] = [
  {
    name: 'boundary_invalid/B1',
    req: request(failedResult(), 'unidirectional'),
    opts: detectOptions(['ineffective', 'ineffective', 'ineffective']),
    expected: 'boundary_invalid',
    rule: 'B1',
  },
  {
    name: 'boundary_invalid/B2+B3',
    req: request(blockedResult(), 'cyclic'),
    expected: 'boundary_invalid',
  },
  {
    name: 'type_misjudged/M1',
    req: request(failedResult(), 'unidirectional'),
    opts: detectOptions(['ineffective']),
    expected: 'type_misjudged',
    rule: 'M1',
  },
  {
    name: 'type_misjudged/M2',
    req: request(failedResult(`详情含 ${MODE_MARKERS.worsened}`), 'cyclic'),
    opts: detectOptions(['ineffective']),
    expected: 'type_misjudged',
    rule: 'M2',
  },
  {
    name: 'type_misjudged/M3',
    req: request(failedResult(`详情含 ${MODE_MARKERS.unilateral_definition_change}`), 'structural_duality'),
    opts: detectOptions(['ineffective']),
    expected: 'type_misjudged',
    rule: 'M3',
  },
  {
    name: 'type_misjudged/M4',
    req: request(failedResult(`详情含 ${MODE_MARKERS.feedback_introduced}`), 'structural_duality'),
    opts: detectOptions(['ineffective']),
    expected: 'type_misjudged',
    rule: 'M4',
  },
  {
    name: 'ineffective',
    req: request(failedResult(), 'nested'),
    expected: 'ineffective',
  },
  {
    name: 'effective',
    req: request(succeededResult(), 'structural_duality'),
    expected: 'effective',
  },
];

describe('SPEC §4 输出不变量（八种代表性输入全扫）', () => {
  for (const testCase of cases) {
    it(`${testCase.name}：signal_type / reason / evidence / assumed_type / 回退字段全部合规`, () => {
      const signal = detect(testCase.req, testCase.opts);

      expect(signal.signal_type).toBe(testCase.expected);
      expect(signal.assumed_type).toBe(testCase.req.classification.causal_type);
      expect(signal.reason.length).toBeGreaterThan(0);
      expect(signal.evidence.length).toBeGreaterThan(0);
      for (const item of signal.evidence) {
        expect(typeof item.statement).toBe('string');
        expect(item.statement.length).toBeGreaterThan(0);
        expect(typeof item.rule_id).toBe('string');
        expect(item.rule_id.length).toBeGreaterThan(0);
      }
      if (testCase.rule !== undefined) {
        expect(signal.evidence.map((item) => item.rule_id)).toContain(testCase.rule);
      }
      expectSignalInvariants(signal, testCase.name);
    });
  }
});

describe('SPEC §6-3 suggested_rollback 只在 type_misjudged 时存在', () => {
  it('非 type_misjudged 的三种信号：字段必须不存在（own property 缺席，且不是 null）', () => {
    const violations: string[] = [];
    for (const testCase of cases) {
      const signal = detect(testCase.req, testCase.opts);
      if (signal.signal_type === 'type_misjudged') {
        if (signal.suggested_rollback === undefined || signal.suggested_rollback === null) {
          violations.push(`${testCase.name}: type_misjudged 缺失 suggested_rollback`);
        }
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(signal, 'suggested_rollback')) {
        violations.push(`${testCase.name}: ${signal.signal_type} 不得存在 suggested_rollback 字段`);
      }
      if (signal.suggested_rollback !== undefined) {
        violations.push(`${testCase.name}: ${signal.signal_type} 的 suggested_rollback 必须为 undefined`);
      }
      if ((signal as { suggested_rollback?: unknown }).suggested_rollback === null) {
        violations.push(`${testCase.name}: 不可用 null 代替缺席`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('四条 M 规则的 kind / target_type 逐条固定（M4 必须 restore_type）', () => {
    const expectation: Readonly<Record<string, { kind: string; target: string }>> = {
      M1: { kind: 'recheck_type', target: 'cyclic' },
      M2: { kind: 'recheck_type', target: 'unidirectional' },
      M3: { kind: 'recheck_type', target: 'unidirectional' },
      M4: { kind: 'restore_type', target: 'structural_duality' },
    };
    const violations: string[] = [];
    for (const testCase of cases) {
      if (testCase.rule === undefined || !testCase.rule.startsWith('M')) continue;
      const signal = detect(testCase.req, testCase.opts);
      const expected = expectation[testCase.rule];
      if (!expected) continue;
      if (signal.suggested_rollback?.kind !== expected.kind) {
        violations.push(`${testCase.rule}: kind=${String(signal.suggested_rollback?.kind)} ≠ ${expected.kind}`);
      }
      if (signal.suggested_rollback?.target_type !== expected.target) {
        violations.push(
          `${testCase.rule}: target=${String(signal.suggested_rollback?.target_type)} ≠ ${expected.target}`,
        );
      }
    }
    expect(violations).toStrictEqual([]);
  });
});

describe('SPEC §6-5 不得执行回退', () => {
  it('输出对象递归键名不含 executed / applied / rollback_performed', () => {
    const violations: string[] = [];
    for (const testCase of cases) {
      const signal = detect(testCase.req, testCase.opts);
      for (const key of collectKeys(signal)) {
        if (EXECUTED_KEY_NAMES.includes(key)) violations.push(`${testCase.name}: 含字段 ${key}`);
      }
      const serialized = JSON.stringify(signal);
      for (const forbidden of EXECUTED_KEY_NAMES) {
        if (serialized.includes(`"${forbidden}"`)) {
          violations.push(`${testCase.name}: 序列化结果含 ${forbidden}`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('输出只含契约声明的五个字段（不多输出内部状态）', () => {
    const allowed = ['signal_type', 'reason', 'evidence', 'suggested_rollback', 'assumed_type'];
    const violations: string[] = [];
    for (const testCase of cases) {
      const signal = detect(testCase.req, testCase.opts);
      for (const key of Object.keys(signal)) {
        if (!allowed.includes(key)) violations.push(`${testCase.name}: 多出字段 ${key}`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('纯函数：调用后 request 与 options 深快照不变（不改入参）', () => {
    for (const testCase of cases) {
      const req = structuredClone(testCase.req);
      const opts = testCase.opts === undefined ? undefined : structuredClone(testCase.opts);
      expectPureCall(
        (r, o) => feedbackPlugin.detectSignal(r, o),
        req,
        opts,
      );
    }
  });

  it('纯函数：同一 request 对象被反复调用，第二次结论仍与第一次深度相等', () => {
    const req = structuredClone(cases[3]?.req as FeedbackRequest);
    const first = detect(req, detectOptions(['ineffective']));
    const second = detect(req, detectOptions(['ineffective']));
    expect(first).toStrictEqual(second);
  });
});

describe('SPEC §6-8 确定性', () => {
  it('同一输入两次调用 toStrictEqual（八种代表性输入）', () => {
    const violations: string[] = [];
    for (const testCase of cases) {
      const first = detect(testCase.req, testCase.opts);
      const second = detect(testCase.req, testCase.opts);
      try {
        expect(first).toStrictEqual(second);
      } catch (error) {
        violations.push(`${testCase.name}: ${String(error)}`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('options 缺省与显式空 history 等价', () => {
    const req = request(succeededResult(), 'cyclic');
    expect(detect(req)).toStrictEqual(detect(req, { history: { previous_signals: [] } }));
  });
});

describe('对抗性：多触发条件叠加与规格未列举输入', () => {
  it('B1 + B2 + B3 同时成立 ⇒ boundary_invalid、无回退建议', () => {
    const result = makeResult({
      status: 'blocked',
      signals: [signalAt(0, 'step_a', 'skipped_forbidden', '越界'), summaryAt('p1')],
      blocked_actions: [{ action: 'step_a', reason: 'forbidden' }],
    });
    const signal = detect(
      request(result, 'cyclic', { boundary: fbBoundary({ max_rounds: 1 }) }),
      detectOptions(['ineffective']),
    );
    expect(signal.signal_type).toBe('boundary_invalid');
    expect(Object.prototype.hasOwnProperty.call(signal, 'suggested_rollback')).toBe(false);
    expect(signal.evidence.map((item) => item.rule_id).some((id) => id.startsWith('B'))).toBe(true);
  });

  it('M1–M4 条件齐备时仍先看 B：status=blocked + 全部 M 标记 ⇒ boundary_invalid', () => {
    const result = makeResult({
      status: 'blocked',
      signals: [
        observedAt(0, 'step_a', `${MODE_MARKERS.unilateral_definition_change} / ${MODE_MARKERS.feedback_introduced}`),
        summaryAt('p1'),
      ],
    });
    const signal = detect(request(result, 'structural_duality'), detectOptions(['ineffective']));
    expect(signal.signal_type).toBe('boundary_invalid');
    expect(Object.prototype.hasOwnProperty.call(signal, 'suggested_rollback')).toBe(false);
  });

  it('history.rollback_count 不参与判定（SPEC §3.1 只数 previous_signals 的 ineffective）', () => {
    const req = request(failedResult(), 'nested');
    const withCount = detect(req, { history: history([], { rollback_count: 9 }) });
    const withoutCount = detect(req, detectOptions([]));
    expect(withCount).toStrictEqual(withoutCount);
    expect(withCount.signal_type).toBe('ineffective');
  });

  it('succeeded 但结构上并非所有步骤 ok（require_all_ok 缺省 true）⇒ 不判 effective', () => {
    const inconsistent = makeResult({
      status: 'succeeded',
      signals: [
        observedAt(0, 'step_a'),
        signalAt(1, 'step_b', 'not_attempted', '未执行'),
        summaryAt('p1'),
      ],
    });
    const signal = detect(request(inconsistent, 'cyclic'));
    // 规格只规定 effective 需"所有步骤 ok"、ineffective 需 status !== succeeded；
    // 此不一致输入两者的字面前提都不满足，故这里只断言不落入 boundary_invalid/effective。
    expect(signal.signal_type).not.toBe('boundary_invalid');
    expect(signal.signal_type).not.toBe('effective');
    // 现状记录：实现把它归为 ineffective
    expect(signal.signal_type).toBe('ineffective');
    expect(signalViolations(signal, 'inconsistent-succeeded')).toStrictEqual([]);
  });

  it('分类结论的其余字段不被回显（参考结构只读 causal_type/confidence/sub_modules）', () => {
    const signal = detect(
      request(succeededResult(), 'structural_duality', {
        classification: {
          causal_type: 'structural_duality',
          confidence: 0.37,
          sub_modules: [{ name: '甲' }],
        },
      }),
    );
    expect(signal.assumed_type).toBe('structural_duality');
    expect(JSON.stringify(signal)).not.toContain('0.37');
    expect(JSON.stringify(signal)).not.toContain('甲');
    expect(signalViolations(signal, 'no-echo')).toStrictEqual([]);
  });
});