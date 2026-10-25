import { describe, expect, it } from 'vitest';

import { detectSignal } from '@clis/clis-feedback';

import {
  boundary,
  emptyHistory,
  repeatedHistory,
  request,
  result,
  sig,
} from './fixtures';

/**
 * SPEC-feedback §6「实现方」要求：四种信号类型各 ≥2 例。
 * 每条断言：signal_type 正确 + reason 非空 + evidence 非空且每条 statement 非空。
 */
function expectSignal(
  signal: ReturnType<typeof detectSignal>,
  expectedType: string,
): void {
  expect(signal.signal_type).toBe(expectedType);
  expect(typeof signal.reason).toBe('string');
  expect(signal.reason.trim().length).toBeGreaterThan(0);
  expect(Array.isArray(signal.evidence)).toBe(true);
  expect(signal.evidence.length).toBeGreaterThan(0);
  for (const item of signal.evidence) {
    expect(item.statement.trim().length).toBeGreaterThan(0);
    expect(item.rule_id.length).toBeGreaterThan(0);
  }
  expect(signal.assumed_type).toBe(signal.assumed_type);
}

describe('effective', () => {
  it('全部步骤 observed ⇒ effective，无回退建议', () => {
    const signal = detectSignal(
      request(result('succeeded'), 'cyclic'),
      { history: emptyHistory() },
    );
    expectSignal(signal, 'effective');
    expect(signal.suggested_rollback).toBeUndefined();
  });

  it('require_all_ok=false 时只要 status=succeeded ⇒ effective', () => {
    const res = result('succeeded', [sig('not_attempted', '跳过', 0), sig('summary', '汇总', -1, 'summary')]);
    const signal = detectSignal(
      request(res, 'unidirectional', boundary({ require_all_ok: false })),
      { history: emptyHistory() },
    );
    expectSignal(signal, 'effective');
    expect(signal.suggested_rollback).toBeUndefined();
  });
});

describe('ineffective', () => {
  it('status=failed 但未反复、且假设不矛盾 ⇒ ineffective', () => {
    const signal = detectSignal(
      request(result('failed', [sig('failed', '某步失败'), sig('summary', '汇总', -1, 'summary')]), 'cyclic'),
      { history: emptyHistory() },
    );
    expectSignal(signal, 'ineffective');
    expect(signal.suggested_rollback).toBeUndefined();
  });

  it('status=succeeded 但仍有步骤非 observed 且要求全 ok ⇒ ineffective', () => {
    const res = result('succeeded', [
      sig('observed', '第一步完成', 0),
      sig('not_attempted', '第二步未执行', 1),
      sig('summary', '汇总', -1, 'summary'),
    ]);
    const signal = detectSignal(request(res, 'structural_duality'), { history: emptyHistory() });
    expectSignal(signal, 'ineffective');
  });
});

describe('type_misjudged', () => {
  it('假设 unidirectional、干预无效且反复 ⇒ type_misjudged，建议回退检查 cyclic', () => {
    const signal = detectSignal(
      request(result('failed', [sig('failed', '干预无效'), sig('summary', '汇总', -1, 'summary')]), 'unidirectional'),
      { history: repeatedHistory() },
    );
    expectSignal(signal, 'type_misjudged');
    expect(signal.suggested_rollback?.kind).toBe('recheck_type');
    expect(signal.suggested_rollback?.target_type).toBe('cyclic');
  });

  it('假设 cyclic、越干预越糟 ⇒ type_misjudged，建议回退检查 unidirectional', () => {
    const res = result('failed', [sig('failed', 'worsened：越干预越糟'), sig('summary', '汇总', -1, 'summary')]);
    const signal = detectSignal(request(res, 'cyclic'), { history: repeatedHistory() });
    expectSignal(signal, 'type_misjudged');
    expect(signal.suggested_rollback?.target_type).toBe('unidirectional');
    expect(signal.suggested_rollback?.kind).toBe('recheck_type');
  });

  it('假设 structural_duality、一方单方面改定义 ⇒ 建议检查 unidirectional', () => {
    const res = result('failed', [
      sig('observed', 'unilateral_definition_change：一方单方面改定义'),
      sig('summary', '汇总', -1, 'summary'),
    ]);
    const signal = detectSignal(request(res, 'structural_duality'), { history: repeatedHistory() });
    expectSignal(signal, 'type_misjudged');
    expect(signal.suggested_rollback?.target_type).toBe('unidirectional');
  });

  it('假设 structural_duality、强行引入反馈后失稳 ⇒ restore_type 回到 structural_duality', () => {
    const res = result('failed', [
      sig('failed', 'feedback_introduced：强行引入反馈后失稳'),
      sig('summary', '汇总', -1, 'summary'),
    ]);
    const signal = detectSignal(request(res, 'structural_duality'), { history: repeatedHistory() });
    expectSignal(signal, 'type_misjudged');
    expect(signal.suggested_rollback?.kind).toBe('restore_type');
    expect(signal.suggested_rollback?.target_type).toBe('structural_duality');
  });
});

describe('boundary_invalid', () => {
  it('连续无效干预超过 max_rounds ⇒ boundary_invalid，无回退建议', () => {
    const signal = detectSignal(
      request(result('failed'), 'cyclic', boundary({ max_rounds: 2 })),
      { history: { previous_signals: ['ineffective', 'ineffective'] } },
    );
    expectSignal(signal, 'boundary_invalid');
    expect(signal.suggested_rollback).toBeUndefined();
  });

  it('执行期发生边界拦截 ⇒ boundary_invalid', () => {
    const res = result('blocked', [sig('summary', '被阻断', -1, 'summary')], [
      { action: 'apply_symmetric_adjustment', reason: 'forbidden' },
    ]);
    const signal = detectSignal(request(res, 'structural_duality'), { history: emptyHistory() });
    expectSignal(signal, 'boundary_invalid');
    expect(signal.suggested_rollback).toBeUndefined();
  });

  it('status=blocked ⇒ boundary_invalid（优先级高于 ineffective）', () => {
    const signal = detectSignal(
      request(result('blocked', [sig('summary', '整条未执行', -1, 'summary')]), 'cyclic'),
      { history: emptyHistory() },
    );
    expectSignal(signal, 'boundary_invalid');
  });
});

describe('回退建议只在 type_misjudged 时出现', () => {
  it('effective / ineffective / boundary_invalid 三者均无 suggested_rollback 字段', () => {
    const cases = [
      detectSignal(request(result('succeeded'), 'cyclic'), { history: emptyHistory() }),
      detectSignal(request(result('failed'), 'cyclic'), { history: emptyHistory() }),
      detectSignal(request(result('blocked'), 'cyclic'), { history: emptyHistory() }),
    ];

    for (const signal of cases) {
      expect('suggested_rollback' in signal).toBe(false);
    }
  });
});

describe('“把循环因果当单向因果”的误判场景（任务书指定）', () => {
  it('假设 unidirectional 处理实为循环的问题 ⇒ 反复无效后判为 type_misjudged 并建议检查 cyclic', () => {
    // 场景：真实因果是"供需↔价格"的回路，却被当成"火→热"式单向因果。
    // 单向干预在回路上会被反馈抵消，表现为反复无效。
    const res = result('failed', [
      sig('failed', '施加单向干预后问题复发'),
      sig('failed', '再次施加仍复发', 1),
      sig('summary', '2 步，状态 failed', -1, 'summary'),
    ]);

    const signal = detectSignal(request(res, 'unidirectional'), {
      history: { previous_signals: ['ineffective', 'ineffective'] },
    });

    expectSignal(signal, 'type_misjudged');
    expect(signal.assumed_type).toBe('unidirectional');
    expect(signal.suggested_rollback?.target_type).toBe('cyclic');
    expect(signal.reason).toContain('单向');
  });
});