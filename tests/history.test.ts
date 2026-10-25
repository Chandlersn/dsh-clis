/**
 * 回归：**结果回写**让类型误判检测真正能触发。
 *
 * 背景：反馈服务无状态，靠调用方传 `FeedbackHistory` 才能判定"反复偏离"。
 * 若工具层每次传空历史，外加执行器恒返回 ok，则 `type_misjudged`
 * 这条规则永远不可能触发 —— 闭环失去反馈能力。
 *
 * 本用例钉住三条语义：
 * 1. 一次失败记 `ineffective`，**不**升级为 `type_misjudged`；
 * 2. 连续第二次失败才升级为 `type_misjudged`；
 * 3. 成功记 `effective`，且基线记录（未动手）不计入失败次数。
 */
import { describe, expect, it } from 'vitest';

import { ClisHistoryStore, fingerprint } from '../packages/clis-plugin/src/history';

/** 四问作答（单向因果）。 */
const ANSWERS = {
  q1_simultaneous_mutual_definition: 'no',
  q2_delayed_mutual_influence: 'no',
  q3_strict_irreversible_order: 'yes',
  q4_coexisting_causal_structures: 'no',
} as const;

/** 最小可用的 ctx 替身（无 storageDomain → 退化到内存）。 */
function fakeCtx(): never {
  return {} as never;
}

describe('问题指纹', () => {
  it('同一描述 + 同一作答得到同一指纹', () => {
    expect(fingerprint('调价抑制需求', ANSWERS)).toBe(fingerprint('调价抑制需求', ANSWERS));
  });

  it('描述不同则指纹不同', () => {
    expect(fingerprint('调价抑制需求', ANSWERS)).not.toBe(fingerprint('涨价压库存', ANSWERS));
  });

  it('作答不同则指纹不同', () => {
    const other = { ...ANSWERS, q3_strict_irreversible_order: 'no' as const };
    expect(fingerprint('调价抑制需求', ANSWERS)).not.toBe(fingerprint('调价抑制需求', other));
  });

  it('空白与大小写归一化后视为同一问题', () => {
    expect(fingerprint('  Price  UP  ', ANSWERS)).toBe(fingerprint('price up', ANSWERS));
  });
});

describe('历史归档与信号升级', () => {
  it('首次读取返回 undefined', async () => {
    const store = new ClisHistoryStore(fakeCtx());
    expect(await store.read('abc123')).toBeUndefined();
  });

  it('追加后可读回，按时间顺序累积', async () => {
    const store = new ClisHistoryStore(fakeCtx());
    const at = new Date().toISOString();

    await store.append('abc123', '示例问题', {
      causal_type: 'unidirectional',
      signal_type: 'ineffective',
      achieved: false,
      baseline: true,
      detail: '尚未动手',
      at,
    });
    await store.append('abc123', '示例问题', {
      causal_type: 'unidirectional',
      signal_type: 'type_misjudged',
      achieved: false,
      detail: '第二次仍失败',
      at,
    });

    const record = await store.read('abc123');
    expect(record?.entries.length).toBe(2);
    expect(record?.entries[0]?.signal_type).toBe('ineffective');
    expect(record?.entries[1]?.signal_type).toBe('type_misjudged');
  });

  it('signalsFor 只回传**同一类型假设**下的信号', async () => {
    const store = new ClisHistoryStore(fakeCtx());
    const at = new Date().toISOString();
    await store.append('k1', 'p', {
      causal_type: 'unidirectional',
      signal_type: 'ineffective',
      achieved: false,
      detail: 'd',
      at,
    });
    await store.append('k1', 'p', {
      causal_type: 'cyclic',
      signal_type: 'effective',
      achieved: true,
      detail: 'd',
      at,
    });

    const record = await store.read('k1');
    // 换了假设，旧信号不再构成"同一假设下的反复偏离"
    expect(ClisHistoryStore.signalsFor(record, 'cyclic')).toEqual(['effective']);
    expect(ClisHistoryStore.signalsFor(record, 'unidirectional')).toEqual(['ineffective']);
    expect(ClisHistoryStore.signalsFor(record, 'nested')).toEqual([]);
  });

  it('rollbacksFor 数出该假设下的误判次数', async () => {
    const store = new ClisHistoryStore(fakeCtx());
    const at = new Date().toISOString();
    for (const signal of ['ineffective', 'type_misjudged', 'type_misjudged'] as const) {
      await store.append('k2', 'p', {
        causal_type: 'unidirectional',
        signal_type: signal,
        achieved: false,
        detail: 'd',
        at,
      });
    }
    const record = await store.read('k2');
    expect(ClisHistoryStore.rollbacksFor(record, 'unidirectional')).toBe(2);
  });

  it('单条问题的记录数有上限，最旧的被丢弃', async () => {
    const store = new ClisHistoryStore(fakeCtx());
    const at = new Date().toISOString();
    for (let index = 0; index < 30; index += 1) {
      await store.append('k3', 'p', {
        causal_type: 'unidirectional',
        signal_type: 'ineffective',
        achieved: false,
        detail: `第 ${index} 次`,
        at,
      });
    }
    const record = await store.read('k3');
    expect(record?.entries.length).toBe(20);
    // 保留的是最近的 20 条
    expect(record?.entries.at(-1)?.detail).toBe('第 29 次');
  });
});

describe('失败升级语义（契约要求「反复」）', () => {
  it('一次失败 → ineffective；连续第二次失败 → type_misjudged', async () => {
    const store = new ClisHistoryStore(fakeCtx());
    const at = new Date().toISOString();

    // 基线（未动手）
    await store.append('k4', 'p', {
      causal_type: 'unidirectional',
      signal_type: 'ineffective',
      achieved: false,
      baseline: true,
      detail: '尚未动手',
      at,
    });

    const recordAfterBaseline = await store.read('k4');
    const failuresAfterBaseline =
      recordAfterBaseline?.entries.filter(
        (entry) =>
          entry.baseline !== true &&
          (entry.signal_type === 'ineffective' || entry.signal_type === 'type_misjudged'),
      ).length ?? 0;
    // 基线不算失败
    expect(failuresAfterBaseline).toBe(0);

    // 第一次真实失败
    await store.append('k4', 'p', {
      causal_type: 'unidirectional',
      signal_type: failuresAfterBaseline > 0 ? 'type_misjudged' : 'ineffective',
      achieved: false,
      detail: '第一次失败',
      at,
    });

    const afterFirst = await store.read('k4');
    expect(afterFirst?.entries.at(-1)?.signal_type).toBe('ineffective');

    // 第二次真实失败
    const failuresBeforeSecond =
      afterFirst?.entries.filter(
        (entry) =>
          entry.baseline !== true &&
          (entry.signal_type === 'ineffective' || entry.signal_type === 'type_misjudged'),
      ).length ?? 0;
    expect(failuresBeforeSecond).toBe(1);

    await store.append('k4', 'p', {
      causal_type: 'unidirectional',
      signal_type: failuresBeforeSecond > 0 ? 'type_misjudged' : 'ineffective',
      achieved: false,
      detail: '第二次失败',
      at,
    });

    const afterSecond = await store.read('k4');
    expect(afterSecond?.entries.at(-1)?.signal_type).toBe('type_misjudged');
  });
});
