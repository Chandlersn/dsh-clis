/**
 * SPEC-feedback §3 四种信号类型的判定与优先级、§6 验证方第 1/2/3 项。
 *
 * 期望值全部来自 SPEC §3 的规则表与 §3.4 的标记词约定。
 */
import { describe, expect, it } from 'vitest';

import * as feedbackPlugin from '@clis/clis-feedback';

import {
  MODE_MARKERS,
  blockedResult,
  detectOptions,
  expectEvidenceContainsRule,
  expectSignalInvariants,
  failedResult,
  fbBoundary,
  history,
  makeResult,
  observedAt,
  request,
  signalAt,
  succeededResult,
  summaryAt,
} from './feedback-helpers';

const detect = feedbackPlugin.detectSignal;

describe('SPEC §3 判定优先级：boundary_invalid > type_misjudged > ineffective/effective', () => {
  it('B1：history 中 ineffective 累计 ≥ max_rounds（缺省 3）⇒ boundary_invalid，且无回退建议', () => {
    const result = failedResult(); // 同时满足 M1 的偏离模式，用来验证优先级
    const signal = detect(
      request(result, 'unidirectional'),
      detectOptions(['ineffective', 'ineffective', 'ineffective']),
    );

    expect(signal.signal_type).toBe('boundary_invalid');
    expect(signal.assumed_type).toBe('unidirectional');
    expect(signal.reason.length).toBeGreaterThan(0);
    expectEvidenceContainsRule(signal, 'B1');
    expect(signal.suggested_rollback).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(signal, 'suggested_rollback')).toBe(false);
    expectSignalInvariants(signal, 'B1');
  });

  it('B1 阈值由 boundary.max_rounds 决定：max_rounds=2 且 2 次 ineffective ⇒ 命中', () => {
    const signal = detect(
      request(failedResult(), 'unidirectional', { boundary: fbBoundary({ max_rounds: 2 }) }),
      detectOptions(['ineffective', 'ineffective']),
    );
    expect(signal.signal_type).toBe('boundary_invalid');
    expectEvidenceContainsRule(signal, 'B1');
    expectSignalInvariants(signal, 'B1/max_rounds=2');
  });

  it('B1 未达阈值不触发：max_rounds=3 且仅 2 次 ineffective ⇒ 落到 M1（type_misjudged）', () => {
    const signal = detect(
      request(failedResult(), 'unidirectional', { boundary: fbBoundary({ max_rounds: 3 }) }),
      detectOptions(['ineffective', 'ineffective']),
    );
    expect(signal.signal_type).toBe('type_misjudged');
    expectEvidenceContainsRule(signal, 'M1');
    expect(signal.suggested_rollback).toStrictEqual({
      kind: 'recheck_type',
      target_type: 'cyclic',
      rationale: signal.suggested_rollback?.rationale,
    });
  });

  it('B2：result.blocked_actions 非空 ⇒ boundary_invalid（优先于 M 与 ineffective）', () => {
    const result = makeResult({
      status: 'failed',
      signals: [signalAt(0, 'step_a', 'skipped_forbidden', '越界'), summaryAt('p1')],
      blocked_actions: [{ action: 'step_a', reason: 'forbidden' }],
    });
    const signal = detect(request(result, 'unidirectional'), detectOptions(['ineffective']));

    expect(signal.signal_type).toBe('boundary_invalid');
    expectEvidenceContainsRule(signal, 'B2');
    expect(signal.suggested_rollback).toBeUndefined();
    expectSignalInvariants(signal, 'B2');
  });

  it('B3：result.status === blocked 且无 blocked_actions ⇒ boundary_invalid（B3）', () => {
    // 单因构造：只让 B3 成立，避免 B2 同时成立时归因含糊
    const onlyBlockedStatus = makeResult({
      status: 'blocked',
      signals: [signalAt(0, 'step_a', 'not_attempted', '整条未执行'), summaryAt('p1')],
      blocked_actions: [],
    });
    const signal = detect(request(onlyBlockedStatus, 'cyclic'), detectOptions(['ineffective']));

    expect(signal.signal_type).toBe('boundary_invalid');
    expectEvidenceContainsRule(signal, 'B3');
    expectSignalInvariants(signal, 'B3');
  });

  it('B2 与 B3 同时成立 ⇒ 仍是 boundary_invalid，证据含任一 B 规则', () => {
    // blockedResult() 同时满足 B2（blocked_actions 非空）与 B3（status=blocked）
    const signal = detect(request(blockedResult(), 'cyclic'), detectOptions(['ineffective']));
    expect(signal.signal_type).toBe('boundary_invalid');
    const rules = signal.evidence.map((item) => item.rule_id);
    expect(rules.some((rule) => rule === 'B2' || rule === 'B3')).toBe(true);
    expectSignalInvariants(signal, 'B2+B3');
  });

  it('B1 优先于 effective：status=succeeded 但历史持续无效 ⇒ 仍判越界', () => {
    const signal = detect(
      request(succeededResult(), 'structural_duality'),
      detectOptions(['ineffective', 'ineffective', 'ineffective']),
    );
    expect(signal.signal_type).toBe('boundary_invalid');
    expectEvidenceContainsRule(signal, 'B1');
  });

  it('type_misjudged 优先于 effective：succeeded 但出现单方面改定义标记 ⇒ 判误判', () => {
    const result = makeResult({
      status: 'succeeded',
      signals: [
        observedAt(0, 'step_a', `执行器回执：${MODE_MARKERS.unilateral_definition_change}`),
        summaryAt('p1'),
      ],
    });
    const signal = detect(request(result, 'structural_duality'), detectOptions(['ineffective']));

    expect(signal.signal_type).toBe('type_misjudged');
    expectEvidenceContainsRule(signal, 'M3');
    expect(signal.suggested_rollback?.kind).toBe('recheck_type');
    expect(signal.suggested_rollback?.target_type).toBe('unidirectional');
    expectSignalInvariants(signal, 'M3/over-effective');
  });

  it('type_misjudged 优先于 ineffective：failed + 反复 + 假设 unidirectional ⇒ 判误判而非无效', () => {
    const signal = detect(request(failedResult(), 'unidirectional'), detectOptions(['ineffective']));
    expect(signal.signal_type).toBe('type_misjudged');
  });
});

describe('SPEC §3.2 M1 —— unidirectional 假设下干预无效且反复', () => {
  it('M1 命中：status !== succeeded + history 含 ineffective ⇒ recheck_type / cyclic', () => {
    const signal = detect(request(failedResult(), 'unidirectional'), detectOptions(['ineffective']));

    expect(signal.signal_type).toBe('type_misjudged');
    expect(signal.suggested_rollback).toStrictEqual({
      kind: 'recheck_type',
      target_type: 'cyclic',
      rationale: signal.suggested_rollback?.rationale,
    });
    expect(signal.suggested_rollback?.rationale.length).toBeGreaterThan(0);
    expectEvidenceContainsRule(signal, 'M1');
    expectSignalInvariants(signal, 'M1');
  });

  it('M1 的"反复"预条件：history 含 type_misjudged 同样算反复', () => {
    const signal = detect(request(failedResult(), 'unidirectional'), detectOptions(['type_misjudged']));
    expect(signal.signal_type).toBe('type_misjudged');
    expectEvidenceContainsRule(signal, 'M1');
  });

  it('M1 的"反复"预条件不满足 ⇒ 退为 ineffective（类型假设仍成立）', () => {
    const signal = detect(request(failedResult(), 'unidirectional'), detectOptions([]));
    expect(signal.signal_type).toBe('ineffective');
    expect(signal.suggested_rollback).toBeUndefined();
    expectSignalInvariants(signal, 'M1-precondition-missing');
  });

  it('M1 不因 history 只有 effective 而触发', () => {
    const signal = detect(
      request(failedResult(), 'unidirectional'),
      detectOptions(['effective', 'effective']),
    );
    expect(signal.signal_type).toBe('ineffective');
  });
});

describe('SPEC §3.2 M2 —— cyclic 假设下越干预越糟', () => {
  it('M2 命中：status=failed + worsened 标记 + 反复 ⇒ recheck_type / unidirectional', () => {
    const result = failedResult(`执行器回执：${MODE_MARKERS.worsened}`);
    const signal = detect(request(result, 'cyclic'), detectOptions(['ineffective']));

    expect(signal.signal_type).toBe('type_misjudged');
    expect(signal.suggested_rollback?.kind).toBe('recheck_type');
    expect(signal.suggested_rollback?.target_type).toBe('unidirectional');
    expectEvidenceContainsRule(signal, 'M2');
    expectSignalInvariants(signal, 'M2');
  });

  it('M2 不适用于 unidirectional 假设（假设类型必须匹配）', () => {
    const result = failedResult(`执行器回执：${MODE_MARKERS.worsened}`);
    const signal = detect(request(result, 'unidirectional'), detectOptions(['ineffective']));
    // 假设为 unidirectional 时按 M1 处理
    expect(signal.signal_type).toBe('type_misjudged');
    expectEvidenceContainsRule(signal, 'M1');
    expect(signal.suggested_rollback?.target_type).toBe('cyclic');
  });
});

describe('SPEC §3.2 M3 —— structural_duality 假设下一方单方面改定义', () => {
  it('M3 命中：存在 unilateral_definition_change ⇒ recheck_type / unidirectional', () => {
    const result = makeResult({
      status: 'failed',
      signals: [
        observedAt(0, 'step_a', `执行器回执：${MODE_MARKERS.unilateral_definition_change}`),
        summaryAt('p1'),
      ],
    });
    const signal = detect(request(result, 'structural_duality'), detectOptions(['ineffective']));

    expect(signal.signal_type).toBe('type_misjudged');
    expect(signal.suggested_rollback?.kind).toBe('recheck_type');
    expect(signal.suggested_rollback?.target_type).toBe('unidirectional');
    expectEvidenceContainsRule(signal, 'M3');
    expectSignalInvariants(signal, 'M3');
  });

  it('标记词大小写敏感：`UNILATERAL_DEFINITION_CHANGE` 不构成 M3 模式', () => {
    const result = makeResult({
      status: 'failed',
      signals: [observedAt(0, 'step_a', '执行器回执：UNILATERAL_DEFINITION_CHANGE'), summaryAt('p1')],
    });
    const signal = detect(request(result, 'structural_duality'), detectOptions(['ineffective']));
    expect(signal.signal_type).toBe('ineffective');
  });
});

describe('SPEC §3.2 M4 —— structural_duality 假设下强行引入反馈后失稳', () => {
  it('M4 命中：feedback_introduced + status=failed ⇒ restore_type / structural_duality', () => {
    const result = failedResult(`执行器回执：${MODE_MARKERS.feedback_introduced}`);
    const signal = detect(request(result, 'structural_duality'), detectOptions(['ineffective']));

    expect(signal.signal_type).toBe('type_misjudged');
    expect(signal.suggested_rollback?.kind).toBe('restore_type');
    expect(signal.suggested_rollback?.target_type).toBe('structural_duality');
    expectEvidenceContainsRule(signal, 'M4');
    expectSignalInvariants(signal, 'M4');
  });

  it('M4 与 M1–M3 语义不可混用：restore_type 而非 recheck_type', () => {
    const result = failedResult(`执行器回执：${MODE_MARKERS.feedback_introduced}`);
    const signal = detect(request(result, 'structural_duality'), detectOptions(['ineffective']));
    expect(signal.suggested_rollback?.kind).not.toBe('recheck_type');
    expect(signal.suggested_rollback?.kind).toBe('restore_type');
  });

  it('M4 要求 status=failed：succeeded 且带 feedback_introduced 标记不触发 M4', () => {
    const result = makeResult({
      status: 'succeeded',
      signals: [
        observedAt(0, 'step_a', `执行器回执：${MODE_MARKERS.feedback_introduced}`),
        summaryAt('p1'),
      ],
    });
    const signal = detect(request(result, 'structural_duality'), detectOptions(['ineffective']));
    expect(signal.signal_type).toBe('effective');
  });

  it('M3 与 M4 同时满足时按 §3.2 表顺序取 M3', () => {
    const result = failedResult(
      `执行器回执：${MODE_MARKERS.unilateral_definition_change} / ${MODE_MARKERS.feedback_introduced}`,
    );
    const signal = detect(request(result, 'structural_duality'), detectOptions(['ineffective']));

    expect(signal.signal_type).toBe('type_misjudged');
    expect(signal.suggested_rollback?.kind).toBe('recheck_type');
    expect(signal.suggested_rollback?.target_type).toBe('unidirectional');
    expectEvidenceContainsRule(signal, 'M3');
  });
});

describe('SPEC §3.3 ineffective', () => {
  it('failed 且无历史 ⇒ ineffective，无回退建议', () => {
    const signal = detect(request(failedResult(), 'cyclic'));
    expect(signal.signal_type).toBe('ineffective');
    expect(signal.assumed_type).toBe('cyclic');
    expect(signal.reason.length).toBeGreaterThan(0);
    expect(signal.suggested_rollback).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(signal, 'suggested_rollback')).toBe(false);
    expectSignalInvariants(signal, 'ineffective');
  });

  it('偏离未反复（history 只有 effective）⇒ ineffective', () => {
    const signal = detect(request(failedResult(), 'cyclic'), detectOptions(['effective']));
    expect(signal.signal_type).toBe('ineffective');
    expect(signal.evidence.length).toBeGreaterThan(0);
  });

  it('M 规则未覆盖的假设类型（nested）⇒ ineffective（不强行判误判）', () => {
    // M1–M4 只覆盖 unidirectional / cyclic / structural_duality；nested 无对应规则
    const signal = detect(
      request(failedResult('普通失败，无模式标记'), 'nested'),
      detectOptions(['ineffective']),
    );
    expect(signal.signal_type).toBe('ineffective');
  });

  it('M2 的偏离模式是 status=failed（§3.2 表），worsened 标记不是必要条件', () => {
    // 现状记录：cyclic + failed + 反复 ⇒ 即使 detail 无 worsened 标记也命中 M2
    const signal = detect(request(failedResult('普通失败'), 'cyclic'), detectOptions(['ineffective']));
    expect(signal.signal_type).toBe('type_misjudged');
    expectEvidenceContainsRule(signal, 'M2');
  });
});

describe('SPEC §3.4 effective', () => {
  it('succeeded 且每步 ok ⇒ effective', () => {
    const signal = detect(request(succeededResult(), 'structural_duality'));
    expect(signal.signal_type).toBe('effective');
    expect(signal.assumed_type).toBe('structural_duality');
    expect(signal.reason.length).toBeGreaterThan(0);
    expect(signal.evidence.length).toBeGreaterThan(0);
    expect(signal.suggested_rollback).toBeUndefined();
    expectSignalInvariants(signal, 'effective');
  });

  it('require_all_ok === false 时只要 succeeded 即 effective', () => {
    const result = makeResult({
      status: 'succeeded',
      // 结构上不一致：succeeded 却含 not_attempted 步骤
      signals: [observedAt(0, 'step_a'), signalAt(1, 'step_b', 'not_attempted', '未执行'), summaryAt('p1')],
    });
    const signal = detect(
      request(result, 'cyclic', { boundary: fbBoundary({ require_all_ok: false }) }),
    );
    expect(signal.signal_type).toBe('effective');
    expectSignalInvariants(signal, 'effective/require_all_ok=false');
  });

  it('require_all_ok 缺省视为 true：并非所有步骤 ok 时不判 effective', () => {
    const result = makeResult({
      status: 'succeeded',
      signals: [observedAt(0, 'step_a'), signalAt(1, 'step_b', 'not_attempted', '未执行'), summaryAt('p1')],
    });
    const signal = detect(request(result, 'cyclic'));
    expect(signal.signal_type).not.toBe('effective');
    expect(signal.signal_type).not.toBe('boundary_invalid');
  });
});

describe('SPEC §3.1 阈值边界与 max_rounds', () => {
  it('max_rounds=0 且已有 1 次 ineffective ⇒ 1 ≥ 0 命中 B1', () => {
    const signal = detect(
      request(failedResult(), 'cyclic', { boundary: fbBoundary({ max_rounds: 0 }) }),
      detectOptions(['ineffective']),
    );
    expect(signal.signal_type).toBe('boundary_invalid');
    expectEvidenceContainsRule(signal, 'B1');
  });

  it('B1 只数 ineffective：history 里 type_misjudged 不计入阈值', () => {
    // nested 假设无 M 规则覆盖，故结果只能是 ineffective —— 纯看阈值是否误触发
    const signal = detect(
      request(failedResult(), 'nested'),
      detectOptions(['type_misjudged', 'type_misjudged', 'type_misjudged', 'type_misjudged']),
    );
    expect(signal.signal_type).not.toBe('boundary_invalid');
    expect(signal.signal_type).toBe('ineffective');
  });

  it('B1 与 M2 同时满足时 B1 优先', () => {
    const result = failedResult(`执行器回执：${MODE_MARKERS.worsened}`);
    const signal = detect(
      request(result, 'cyclic', { boundary: fbBoundary({ max_rounds: 2 }) }),
      detectOptions(['ineffective', 'ineffective']),
    );
    expect(signal.signal_type).toBe('boundary_invalid');
    expectEvidenceContainsRule(signal, 'B1');
  });
});

describe('输入只读性：assumed_type 原样回显', () => {
  it('assumed_type 与 classification.causal_type 逐字一致（四种类型抽样）', () => {
    for (const causalType of ['structural_duality', 'cyclic', 'unidirectional', 'nested'] as const) {
      const signal = detect(request(succeededResult(), causalType));
      expect(signal.assumed_type).toBe(causalType);
    }
    const unknown = detect(
      request(succeededResult(), 'unknown', { classification: { causal_type: 'unknown', confidence: 0.4 } }),
    );
    expect(unknown.assumed_type).toBe('unknown');
    expect(history().previous_signals).toStrictEqual([]);
  });
});