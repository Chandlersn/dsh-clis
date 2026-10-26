/**
 * 回归：`toToolJson` 必须剥掉所有 `undefined` —— 这是工具能被宿主接受的**唯一出口**。
 *
 * 缺陷背景（2026-10-26 真实审查）：
 * 宿主工具输出管线用 `isJsonValue` 校验，规则是**任一属性值为 `undefined`
 * 即整体判非法**，报 `ToolOutputError: value is not lossless JSON`，工具直接不可用。
 * 而契约里的可选字段（`exploration_reason`、`suggested_rollback`、`sub_modules`）
 * 在服务返回时经常是 `字段名: undefined`。
 *
 * 本用例钉住：
 * - 顶层 undefined 被删键（不是置 null）
 * - 嵌套对象、数组元素里的 undefined 同样被删
 * - 合法值（含 null / false / 0 / 空串 / 空数组）必须原样保留
 * - 输出可被 JSON.stringify → parse 往返而不丢结构
 */
import { describe, expect, it } from 'vitest';

import { toToolJson } from '../packages/clis-plugin/src/tool-json';

/** 模拟宿主的严格判据：任一属性值为 undefined 即非法。 */
function hasUndefined(node: unknown, path = '$'): string[] {
  const offenders: string[] = [];
  const walk = (value: unknown, at: string): void => {
    if (value === undefined) {
      offenders.push(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`);
    }
  };
  walk(node, path);
  return offenders;
}

describe('toToolJson 剥离 undefined', () => {
  it('顶层 undefined 属性被删除，而不是变成 null', () => {
    const input = { a: 1, b: undefined, c: 'x' };
    const output = toToolJson(input);

    expect(hasUndefined(output)).toEqual([]);
    expect(Object.hasOwn(output, 'b')).toBe(false);
    expect('b' in output).toBe(false);
  });

  it('嵌套对象里的 undefined 同样被删', () => {
    const input = {
      outer: {
        keep: 'v',
        drop: undefined,
        deep: { alsoDrop: undefined, keepNumber: 0 },
      },
    };
    const output = toToolJson(input);

    expect(hasUndefined(output)).toEqual([]);
    expect(Object.hasOwn(output.outer, 'drop')).toBe(false);
    expect(Object.hasOwn(output.outer.deep, 'alsoDrop')).toBe(false);
    expect(output.outer.deep.keepNumber).toBe(0);
  });

  it('数组元素里的 undefined 被删（数组因此缩短）', () => {
    const input = { list: [1, undefined, 'three', undefined] };
    const output = toToolJson(input);

    expect(hasUndefined(output)).toEqual([]);
    // 关键：null 会留下占位，undefined 必须消失 —— 长度因此变小
    expect(output.list).toEqual([1, 'three']);
  });

  it('数组对象元素内部的 undefined 也被删', () => {
    const input = { items: [{ id: 1, note: undefined }, { id: 2 }] };
    const output = toToolJson(input);

    expect(hasUndefined(output)).toEqual([]);
    expect(output.items).toHaveLength(2);
    const first = output.items[0];
    expect(first).toBeDefined();
    expect(Object.hasOwn(first as object, 'note')).toBe(false);
  });

  it('契约里的真实形态：可选字段缺失被清理', () => {
    // 这正是 clis_classify 的返回形态
    const classification = {
      causal_type: 'cyclic',
      confidence: 0.9,
      needs_exploration: false,
      exploration_reason: undefined, // 未进入探索模式时没有该字段
      judgment_basis: [{ rule_id: 'R2', description: '...' }],
      evidence: [],
      candidate_hypotheses: undefined, // 非 unknown 时没有
      sub_modules: undefined, // 非 nested 时没有
    };

    // 清理前：宿主会整包拒绝
    expect(hasUndefined(classification).length).toBeGreaterThan(0);

    const output = toToolJson(classification);

    // 清理后：干净，且必需字段一个不少
    expect(hasUndefined(output)).toEqual([]);
    expect(output.causal_type).toBe('cyclic');
    expect(output.confidence).toBe(0.9);
    expect(output.needs_exploration).toBe(false);
    expect(Object.hasOwn(output, 'exploration_reason')).toBe(false);
    expect(Object.hasOwn(output, 'candidate_hypotheses')).toBe(false);
  });

  it('合法值原样保留：null / false / 0 / 空串 / 空数组 / 空对象', () => {
    const input = {
      n: null,
      f: false,
      zero: 0,
      empty: '',
      arr: [] as unknown[],
      obj: {},
      nan: Number.NaN,
    };
    const output = toToolJson(input);

    expect(output.n).toBeNull();
    expect(output.f).toBe(false);
    expect(output.zero).toBe(0);
    expect(output.empty).toBe('');
    expect(output.arr).toEqual([]);
    expect(output.obj).toEqual({});
    // NaN 不是 undefined，不该被删（是否合法由宿主另判）
    expect(Object.hasOwn(output, 'nan')).toBe(true);
  });

  it('不修改原对象（纯函数）', () => {
    const input = { a: 1, b: undefined as number | undefined };
    const snapshot = { ...input };
    toToolJson(input);

    expect(input).toEqual(snapshot);
    expect(Object.hasOwn(input, 'b')).toBe(true);
  });

  it('输出可无损往返 JSON', () => {
    const input = {
      traces: [
        { round: 1, action: 'continue', note: undefined, rollback_count: 0 },
        { round: 2, action: 'switch_path', note: '换路径', rollback_count: 1 },
      ],
      history: { times_seen: 2, prior_signals: ['ineffective'], hint: '提示' },
    };
    const output = toToolJson(input);

    // 宿主判据
    expect(hasUndefined(output)).toEqual([]);

    // JSON 往返不丢字段
    const roundTrip = JSON.parse(JSON.stringify(output)) as typeof output;
    expect(roundTrip).toEqual(output);
    expect(roundTrip.traces).toHaveLength(2);
    expect(roundTrip.history.prior_signals).toEqual(['ineffective']);
  });

  it('深层混合结构一次清干净', () => {
    const input = {
      level1: {
        level2: {
          level3: {
            keep: 'ok',
            drop: undefined,
            arr: [1, undefined, { inner: undefined, ok: true }],
          },
        },
        sibling: undefined,
      },
    };
    const output = toToolJson(input);

    expect(hasUndefined(output)).toEqual([]);
    expect(output.level1.level2.level3.keep).toBe('ok');
    expect(output.level1.level2.level3.arr).toEqual([1, { ok: true }]);
  });
});
