import { describe, expect, it } from 'vitest';

import { decide, initialState } from '@clis/clis-orchestrator';

import { ROLLBACK_TO_CYCLIC, round, state } from './fixtures';

/** SPEC-orchestrator §6：六种 action 各 ≥1 例。 */
describe('六种决策', () => {
  it('effective ⇒ continue', () => {
    const { decision } = decide(round('effective'), initialState());
    expect(decision.action).toBe('continue');
    expect(decision.reason.trim().length).toBeGreaterThan(0);
  });

  it('ineffective ⇒ switch_path', () => {
    const { decision } = decide(round('ineffective'), initialState());
    expect(decision.action).toBe('switch_path');
  });

  it('type_misjudged ⇒ rollback_to_classifier，并带上 retry_type', () => {
    const { decision } = decide(
      round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }),
      initialState(),
    );
    expect(decision.action).toBe('rollback_to_classifier');
    expect(decision.retry_type).toBe('cyclic');
    expect(decision.rollback_count).toBe(1);
  });

  it('boundary_invalid ⇒ rollback_to_boundary', () => {
    const { decision } = decide(round('boundary_invalid'), initialState());
    expect(decision.action).toBe('rollback_to_boundary');
    expect(decision.rollback_count).toBe(1);
  });

  it('锁定生效时 ⇒ lock_and_continue', () => {
    const locked = state({
      oscillation: { consecutive_rollbacks: { cyclic: 2 }, locked_type: 'cyclic', lock_remaining: 1 },
    });
    const { decision } = decide(round('ineffective'), locked);
    expect(decision.action).toBe('lock_and_continue');
    expect(decision.locked_type).toBe('cyclic');
  });

  it('回退次数耗尽且仍未解决 ⇒ manual_intervention', () => {
    const exhausted = state({ rollback_count: 3 });
    const { decision } = decide(round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }), exhausted);
    expect(decision.action).toBe('manual_intervention');
    expect(decision.reason).toContain('人工介入');
  });
});

describe('回退上限（默认 3）与震荡锁定的叠加', () => {
  it('连续 type_misjudged 的真实序列：回退、回退+锁定、锁定继续、回退、人工介入', () => {
    let current = initialState();
    const actions: string[] = [];
    const counts: number[] = [];

    for (let index = 0; index < 5; index += 1) {
      const { decision, nextState } = decide(
        round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }),
        current,
      );
      actions.push(decision.action);
      counts.push(decision.rollback_count);
      current = nextState;
    }

    // 锁定抑制"同类型反复回退"，上限兜住"总回退次数"，二者叠加后达到上限需 5 轮。
    expect(actions).toStrictEqual([
      'rollback_to_classifier',
      'rollback_to_classifier',
      'lock_and_continue',
      'rollback_to_classifier',
      'manual_intervention',
    ]);
    expect(counts).toStrictEqual([1, 2, 2, 3, 3]);
    expect(current.rollback_count).toBeLessThanOrEqual(3);
  });

  it('rollback_count 永不超过上限（自定义 limit=2）', () => {
    let current = initialState();
    for (let index = 0; index < 8; index += 1) {
      current = decide(round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }), current, {
        rollback_limit: 2,
      }).nextState;
      expect(current.rollback_count).toBeLessThanOrEqual(2);
    }
  });

  it('达到上限后无论来多少轮都不再回退', () => {
    let current = initialState();
    for (let index = 0; index < 6; index += 1) {
      current = decide(round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }), current).nextState;
    }
    const { decision } = decide(round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }), current);
    expect(decision.action).toBe('manual_intervention');
    expect(decision.rollback_count).toBe(3);
  });
});

describe('震荡锁定', () => {
  it('同一类型连续回退 2 次 ⇒ 下一轮锁定且 rollback_count 不增', () => {
    // 第 1、2 次回退（第 2 次触发锁定）
    const first = decide(round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }), initialState());
    const second = decide(
      round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }),
      first.nextState,
    );

    expect(second.decision.action).toBe('rollback_to_classifier');
    expect(second.nextState.oscillation.locked_type).toBe('cyclic');
    expect(second.nextState.oscillation.lock_remaining).toBe(1);

    // 锁定期间即使 type_misjudged 也不回退
    const third = decide(
      round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }),
      second.nextState,
    );
    expect(third.decision.action).toBe('lock_and_continue');
    expect(third.decision.rollback_count).toBe(second.decision.rollback_count);
  });

  it('effective 会清零震荡计数与锁定', () => {
    const locked = state({
      oscillation: { consecutive_rollbacks: { cyclic: 2 }, locked_type: 'cyclic', lock_remaining: 1 },
    });
    const { nextState } = decide(round('effective'), locked);
    expect(nextState.oscillation.lock_remaining).toBe(0);
    expect(nextState.oscillation.consecutive_rollbacks).toStrictEqual({});
  });
});

describe('trace 完整性', () => {
  it('多轮后 traces 长度等于轮数，且每轮 note 非空、round 连续', () => {
    let current = initialState();
    const sequence = ['ineffective', 'effective', 'ineffective', 'effective'] as const;

    for (const signalType of sequence) {
      current = decide(round(signalType), current).nextState;
    }

    expect(current.traces).toHaveLength(sequence.length);
    current.traces.forEach((trace, index) => {
      expect(trace.round).toBe(index + 1);
      expect(trace.note.trim().length).toBeGreaterThan(0);
    });
  });

  it('人工介入时仍追加 trace（完整 trace 是硬要求）', () => {
    const exhausted = state({ rollback_count: 3 });
    const { nextState } = decide(round('type_misjudged'), exhausted);
    expect(nextState.traces).toHaveLength(1);
    expect(nextState.traces[0]?.action).toBe('manual_intervention');
  });
});

describe('纯函数性质', () => {
  it('不修改传入 state', () => {
    const current = initialState();
    const snapshot = structuredClone(current);
    decide(round('type_misjudged', { rollback: ROLLBACK_TO_CYCLIC }), current);
    expect(current).toStrictEqual(snapshot);
  });

  it('确定性：同输入两次深度相等', () => {
    const current = state({ round: 2, rollback_count: 1 });
    const target = round('ineffective');
    expect(decide(target, current)).toStrictEqual(decide(target, current));
  });
});

describe('畸形输入', () => {
  it('state 畸形 ⇒ 抛契约错误', () => {
    expect(() => decide(round('effective'), { round: -1 } as never)).toThrowError();
  });

  it('rollback_limit 非法 ⇒ 抛契约错误', () => {
    expect(() => decide(round('effective'), initialState(), { rollback_limit: 0 })).toThrowError();
  });
});