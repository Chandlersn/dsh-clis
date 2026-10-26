/**
 * 回归：互查通报的三段式逻辑。
 *
 * 用户要求（2026-10-26）：发现问题通报对方；对方修好就不管；
 * 对方没修或没搞定 → 宿主介入并通报用户。
 *
 * 关键设计：**用"下一轮体检该 code 是否还在"判定对方修了没**，
 * 而不是让对方主动回报 —— 主动回报会漏报、假报；"问题还在不在"
 * 是可观测事实，虽然慢一轮，但可靠。
 *
 * 本用例钉住：
 * - 首次出现 → new（通报对方 + 提示 agent）
 * - 仍存在 → unresolved（只通报对方，不打扰用户）
 * - 连续 N 轮 → escalate（升级，通报用户）
 * - 消失 → resolved（清账）
 * - 已升级过的不重复通报
 */
import { describe, expect, it } from 'vitest';

import type { HealthSeenState } from '../packages/clis-plugin/src/health-seen';
import { reconcileFindings } from '../packages/clis-plugin/src/health-seen';

/** 造一条聚合后的 finding。 */
function finding(code: string, count = 1) {
  return {
    code,
    severity: 'warn',
    message: `${code} 有问题`,
    plugins: ['dsh-memory-manager'] as readonly string[],
    count,
  };
}

/** 空状态。 */
const EMPTY: HealthSeenState = { version: 1, findings: {} };

/** 固定时间戳，便于断言。 */
const T1 = '2026-10-26T01:00:00.000Z';
const T2 = '2026-10-26T02:00:00.000Z';
const T3 = '2026-10-26T03:00:00.000Z';

describe('首次发现', () => {
  it('新 code 处置为 new', () => {
    const { dispositions } = reconcileFindings([finding('R14')], EMPTY, 2, T1);

    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]?.disposition).toBe('new');
    expect(dispositions[0]?.roundsUnresolved).toBe(1);
    expect(dispositions[0]?.alreadyEscalated).toBe(false);
  });

  it('新 code 记入状态，firstSeenAt 为当前时间', () => {
    const { next } = reconcileFindings([finding('R14')], EMPTY, 2, T1);

    expect(next.findings['R14']?.firstSeenAt).toBe(T1);
    expect(next.findings['R14']?.roundsUnresolved).toBe(1);
    expect(next.findings['R14']?.escalated).toBe(false);
  });
});

describe('仍存在但未达升级阈值', () => {
  it('阈值 3 时：第 2 轮仍 unresolved，不打扰用户', () => {
    const first = reconcileFindings([finding('R14')], EMPTY, 3, T1);
    const second = reconcileFindings([finding('R14')], first.next, 3, T2);

    expect(second.dispositions[0]?.disposition).toBe('unresolved');
    expect(second.dispositions[0]?.roundsUnresolved).toBe(2);
  });

  it('阈值 3 时：第 3 轮才升级', () => {
    const first = reconcileFindings([finding('R14')], EMPTY, 3, T1);
    const second = reconcileFindings([finding('R14')], first.next, 3, T2);
    const third = reconcileFindings([finding('R14')], second.next, 3, T3);

    expect(third.dispositions[0]?.disposition).toBe('escalate');
    expect(third.dispositions[0]?.roundsUnresolved).toBe(3);
  });
});

describe('连续未修 → 升级', () => {
  it('达到阈值时处置为 escalate（阈值 2：第 2 轮即升级）', () => {
    const first = reconcileFindings([finding('R14')], EMPTY, 2, T1);
    const second = reconcileFindings([finding('R14')], first.next, 2, T2);

    // 第 1 轮发现、第 2 轮确认仍未修 → 达阈值 2
    expect(second.dispositions[0]?.disposition).toBe('escalate');
  });

  it('升级后状态标记 escalated，且不重复升级', () => {
    const first = reconcileFindings([finding('R14')], EMPTY, 2, T1);
    const second = reconcileFindings([finding('R14')], first.next, 2, T2);
    expect(second.next.findings['R14']?.escalated).toBe(true);

    const third = reconcileFindings([finding('R14')], second.next, 2, T3);
    // 已升级过 → 回落到 unresolved（不再重复打扰用户）
    expect(third.dispositions[0]?.disposition).toBe('unresolved');
    expect(third.dispositions[0]?.alreadyEscalated).toBe(true);
  });
});

describe('对方修好了 → 清账', () => {
  it('code 消失时处置为 resolved', () => {
    const first = reconcileFindings([finding('R14')], EMPTY, 2, T1);
    // 第二轮该问题不再出现（对方修了）
    const second = reconcileFindings([], first.next, 2, T2);

    const resolved = second.dispositions.find((item) => item.code === 'R14');
    expect(resolved?.disposition).toBe('resolved');
  });

  it('resolved 后从状态里移除，不会再被追踪', () => {
    const first = reconcileFindings([finding('R14')], EMPTY, 2, T1);
    const second = reconcileFindings([], first.next, 2, T2);

    expect(second.next.findings['R14']).toBeUndefined();
  });

  it('修好后再出现视为新问题（重新走一遍流程）', () => {
    const first = reconcileFindings([finding('R14')], EMPTY, 2, T1);
    const second = reconcileFindings([], first.next, 2, T2);
    const third = reconcileFindings([finding('R14')], second.next, 2, T3);

    expect(third.dispositions[0]?.disposition).toBe('new');
  });
});

describe('多个 finding 混合', () => {
  it('同时处理新增/未修/已修三种情况', () => {
    // 第一轮：A、B 都是新问题
    const first = reconcileFindings([finding('A'), finding('B')], EMPTY, 2, T1);
    expect(first.dispositions.every((item) => item.disposition === 'new')).toBe(true);

    // 第二轮：A 仍在、B 已修、C 是新增
    const second = reconcileFindings([finding('A'), finding('C')], first.next, 2, T2);

    const byCode = new Map(second.dispositions.map((item) => [item.code, item.disposition]));
    expect(byCode.get('A')).toBe('escalate'); // 第 2 轮达阈值
    expect(byCode.get('B')).toBe('resolved'); // 消失
    expect(byCode.get('C')).toBe('new'); // 新出现
  });
});

describe('状态健壮性', () => {
  it('空输入与空状态互不干扰', () => {
    const result = reconcileFindings([], EMPTY, 2, T1);
    expect(result.dispositions).toHaveLength(0);
    expect(result.next.findings).toEqual({});
  });

  it('保留 firstSeenAt 不被覆盖（可算"存在多久了"）', () => {
    const first = reconcileFindings([finding('A')], EMPTY, 5, T1);
    const second = reconcileFindings([finding('A')], first.next, 5, T2);

    expect(second.next.findings['A']?.firstSeenAt).toBe(T1);
    expect(second.next.findings['A']?.lastSeenAt).toBe(T2);
  });
});
