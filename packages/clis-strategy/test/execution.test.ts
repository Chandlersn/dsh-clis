import { describe, expect, it } from 'vitest';

import { ClisContractError } from '@clis/clis-contracts';
import type { CandidatePath } from '@clis/clis-contracts';

import { executePath, matchPaths } from '@clis/clis-strategy';

import { boundary, makeClassification, makeRecorder, subModule } from './fixtures';

function handBuiltPath(actions: readonly string[]): CandidatePath {
  return {
    path_id: 'hand-1',
    variant: 'probe.minimal',
    variant_version: 'hand',
    library_version: 'hand',
    family: 'probe_and_observe',
    causal_type: 'unknown',
    steps: actions.map((action, index) => ({
      index,
      action,
      params: {},
      rationale: '手搓步骤',
    })),
    blocked_actions: [],
    executable: true,
    components: { type_fit: 1, expected_effect: 1, side_effect_risk: 0, execution_cost: 0 },
    score: 1,
    rank: 1,
    summary: '手搓路径',
  };
}

describe('执行：正常路径', () => {
  it('全部 ok ⇒ succeeded，逐步 observed，末条为 summary', async () => {
    const { executor, invocations } = makeRecorder();
    const path = matchPaths(makeClassification('cyclic'), boundary())[0] as CandidatePath;

    const result = await executePath(path, { boundary: boundary(), executor });

    expect(result.status).toBe('succeeded');
    expect(invocations).toHaveLength(3);
    expect(result.signals.map((item) => item.kind)).toStrictEqual([
      'observed',
      'observed',
      'observed',
      'summary',
    ]);
    expect(result.signals.at(-1)?.action).toBe('summary');
    expect(result.signals.at(-1)?.step_index).toBe(-1);
    expect(result.blocked_actions).toStrictEqual([]);
  });

  it('中途 failed ⇒ 停止后续调用，剩余步骤标 not_attempted', async () => {
    const { executor, invocations } = makeRecorder((invocation) =>
      invocation.step_index >= 1
        ? { status: 'failed', detail: '执行器回执：第二步失败' }
        : { status: 'ok', detail: '执行器回执：完成' },
    );
    const path = matchPaths(makeClassification('cyclic'), boundary())[0] as CandidatePath;

    const result = await executePath(path, { boundary: boundary(), executor });

    expect(result.status).toBe('failed');
    expect(invocations).toHaveLength(2);
    expect(result.signals.map((item) => item.kind)).toStrictEqual([
      'observed',
      'failed',
      'not_attempted',
      'summary',
    ]);
  });

  it('signals 恒非空、detail 非空，且不含任何回退字段', async () => {
    const { executor } = makeRecorder();
    const path = matchPaths(makeClassification('structural_duality'), boundary())[0] as CandidatePath;
    const result = await executePath(path, { boundary: boundary(), executor });

    expect(result.signals.length).toBeGreaterThan(0);
    for (const item of result.signals) expect(item.detail.trim().length).toBeGreaterThan(0);
    for (const field of ['rollback', 'suggested_rollback', 'next_action', 'rollback_to']) {
      expect(Object.keys(result)).not.toContain(field);
    }
  });
});

describe('执行：边界阻断 (SPEC §6.1 补注)', () => {
  it('生成态不可执行的路径 ⇒ blocked，执行器调用次数为 0', async () => {
    const { executor, invocations } = makeRecorder();
    const paths = matchPaths(makeClassification('cyclic'), boundary(['inject_damping']));
    const blocked = paths.find((path) => path.variant === 'loop.damping_injection') as CandidatePath;

    expect(blocked.executable).toBe(false);

    const result = await executePath(blocked, {
      boundary: boundary(['inject_damping']),
      executor,
    });

    expect(result.status).toBe('blocked');
    expect(invocations).toHaveLength(0);
    expect(result.blocked_actions).toStrictEqual([
      { action: 'inject_damping', reason: 'forbidden' },
    ]);
    // 生成阶段已剔除动作，故 steps 为空 → 只剩汇总信号。
    expect(result.signals.map((item) => item.kind)).toStrictEqual(['summary']);
    expect(result.signals[0]?.detail).toContain('不可执行');
  });

  it('手搓路径里塞了禁止动作 ⇒ blocked，执行器调用次数为 0，该步记 skipped_forbidden', async () => {
    const { executor, invocations } = makeRecorder();
    const path = handBuiltPath(['probe_environment', 'observe_response']);

    const result = await executePath(path, {
      boundary: boundary(['probe_environment']),
      executor,
    });

    expect(result.status).toBe('blocked');
    expect(invocations).toHaveLength(0);
    expect(result.signals.map((item) => item.kind)).toStrictEqual([
      'skipped_forbidden',
      'not_attempted',
      'summary',
    ]);
  });

  it('生成阶段缺步的路径绝不允许"跳过禁步、跑完剩下的"', async () => {
    // leverage_point 的第一步被禁 ⇒ 若照旧执行，会变成"没定位反馈环就直接干预杠杆点"。
    const { executor, invocations } = makeRecorder();
    const paths = matchPaths(makeClassification('cyclic'), boundary(['map_feedback_loop']));
    const leverage = paths.find((path) => path.variant === 'loop.leverage_point') as CandidatePath;

    expect(leverage.steps.map((step) => step.action)).toStrictEqual([
      'rank_leverage_points',
      'intervene_at_leverage_point',
    ]);

    const result = await executePath(leverage, {
      boundary: boundary(['map_feedback_loop']),
      executor,
    });

    expect(result.status).toBe('blocked');
    expect(invocations).toHaveLength(0);
  });
});

describe('执行：decompose 子路径', () => {
  const nested = makeClassification('nested', {
    sub_modules: [
      subModule('供需环', makeClassification('cyclic')),
      subModule('雨→湿', makeClassification('unidirectional')),
    ],
  });

  it('父 + 两个子模块 ⇒ sub_results 长度 2，父 succeeded', async () => {
    const { executor, invocations } = makeRecorder();
    const root = matchPaths(nested, boundary())[0] as CandidatePath;

    const result = await executePath(root, { boundary: boundary(), executor });

    expect(result.status).toBe('succeeded');
    expect(result.sub_results).toHaveLength(2);
    expect(result.sub_results?.map((sub) => sub.path_id)).toStrictEqual(['p1.1', 'p1.2']);
    // 父 1 步 + 子各若干步
    expect(invocations.length).toBeGreaterThan(1);
  });

  it('子模块首选候选被禁时，改取该子模块次优的可执行候选', async () => {
    const { executor } = makeRecorder();
    const root = matchPaths(nested, boundary(['map_feedback_loop']))[0] as CandidatePath;

    const cycleSub = root.sub_paths?.[0];
    expect(cycleSub?.variant).not.toBe('loop.leverage_point');
    expect(cycleSub?.executable).toBe(true);

    const result = await executePath(root, {
      boundary: boundary(['map_feedback_loop']),
      executor,
    });
    expect(result.status).toBe('succeeded');
  });

  it('某个子模块全部候选都被禁 ⇒ 该子路径 blocked，父汇总为 blocked', async () => {
    const { executor, invocations } = makeRecorder();
    const withProbeSub = makeClassification('nested', {
      sub_modules: [subModule('未知子域', makeClassification('unknown', { confidence: 0.25 }))],
    });
    const root = matchPaths(withProbeSub, boundary(['probe_environment']))[0] as CandidatePath;

    expect(root.executable).toBe(true);
    expect(root.sub_paths?.[0]?.executable).toBe(false);

    const result = await executePath(root, {
      boundary: boundary(['probe_environment']),
      executor,
    });

    expect(result.status).toBe('blocked');
    expect(result.sub_results?.[0]?.status).toBe('blocked');
    // 父自身一步照跑，子路径一次没跑
    expect(invocations).toHaveLength(1);
  });
});

describe('执行：畸形输入', () => {
  it('路径畸形 ⇒ INVALID_PATH', async () => {
    const { executor } = makeRecorder();
    const broken = { path_id: 'x', steps: [{ index: 0, action: '', params: {}, rationale: 'r' }] };

    await expect(
      executePath(broken as unknown as CandidatePath, { boundary: boundary(), executor }),
    ).rejects.toBeInstanceOf(ClisContractError);
  });

  it('缺执行器 ⇒ INVALID_OPTIONS', async () => {
    const path = handBuiltPath(['probe_environment']);
    await expect(
      executePath(path, { boundary: boundary() } as unknown as Parameters<typeof executePath>[1]),
    ).rejects.toBeInstanceOf(ClisContractError);
  });
});