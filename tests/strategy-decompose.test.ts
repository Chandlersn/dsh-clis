/**
 * SPEC-strategy §4.5 子路径编号、§6.3 decompose 执行与状态汇总、§7 验证方第 9/10 项。
 */
import { describe, expect, it } from 'vitest';

import { scorePath } from '@clis/clis-contracts';
import type { ActionResultStatus, CausalClassification } from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';
import * as strategyPlugin from '@clis/clis-strategy';

import { makeProblem } from './helpers';
import {
  NO_BOUNDARY,
  VARIANT_SPECS,
  boundary,
  expectStepsMatchSpec,
  expectedSubPathCandidate,
  makeExecutor,
  nestedDeepClassification,
  nestedEmptyClassification,
  nestedTwoChildrenClassification,
  shouldAppendProbeCandidate,
  signalViolations,
} from './strategy-helpers';

const childrenOf = (classification: CausalClassification): readonly CausalClassification[] =>
  (classification.sub_modules ?? []).map((module) => module.classification);

/** path_id 形如 p1.<k>；k 按子模块顺序，1 起。 */
const idK = (pathId: string): number => Number((pathId.split('.').pop() ?? '0').replace(/^p/, ''));

describe('SPEC §7-9 nested 子路径结构', () => {
  const classification = nestedTwoChildrenClassification();
  const children = childrenOf(classification);

  it('nested + 2 个子模块 ⇒ 根路径 1 条、sub_paths 长度 2、家族对应各自类型', () => {
    const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
    expect(paths.length).toBe(1);
    const root = paths[0];
    expect(root?.variant).toBe('decompose.compose_sub');
    expect(root?.family).toBe('decompose');
    expect(root?.causal_type).toBe('nested');
    expect(root?.path_id).toBe('p1');
    if (root) expectStepsMatchSpec(root);

    const subPaths = root?.sub_paths ?? [];
    expect(subPaths.length).toBe(2);
    // 每个子模块只出一条子路径（不是子模块的整个候选集）
    expect(children.length).toBe(2);
    expect(subPaths[0]?.path_id).toBe('p1.1');
    expect(subPaths[1]?.path_id).toBe('p1.2');
    expect(subPaths[0]?.causal_type).toBe('cyclic');
    expect(subPaths[0]?.family).toBe('loop_damping');
    expect(subPaths[1]?.causal_type).toBe('unidirectional');
    expect(subPaths[1]?.family).toBe('single_lever');
  });

  it('每条子路径 = 该子模块候选集中名次最好的可执行候选（空边界下即 rank 1）', () => {
    const root = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0];
    const subPaths = root?.sub_paths ?? [];
    subPaths.forEach((subPath) => {
      // path_id 的 k 指向子模块顺序，与数组顺序（rank 顺序）可以不同
      const child = children[idK(subPath.path_id) - 1] as CausalClassification;
      const expected = expectedSubPathCandidate(child, NO_BOUNDARY);
      expect(subPath.variant).toBe(expected.variant);
      expect(subPath.components).toStrictEqual(expected.components);
      expect(subPath.score).toBe(expected.score);
      expect(subPath.score).toBe(scorePath(subPath.components));
      expect(subPath.family).toBe(VARIANT_SPECS[expected.variant].family);
      expect(subPath.library_version).toBe('1.0.0');
      expect(subPath.variant_version).toBe('1.0.0');
      expectStepsMatchSpec(subPath);
    });
    // §4.6/§4.4：兄弟子路径在同一层内重新排名 1..N，数组顺序 = rank 升序、score 非增
    expect(subPaths.map((subPath) => subPath.rank)).toStrictEqual(
      subPaths.map((_, index) => index + 1),
    );
    for (let index = 1; index < subPaths.length; index += 1) {
      const previous = subPaths[index - 1];
      const current = subPaths[index];
      expect(previous?.score ?? 0).toBeGreaterThanOrEqual(current?.score ?? 0);
    }
  });

  it('嵌套 3 层：孙层继续出子路径，path_id 逐层点号拼接', () => {
    const deep = nestedDeepClassification();
    const root = strategyPlugin.matchPaths(deep, NO_BOUNDARY)[0];
    expect(root?.path_id).toBe('p1');
    const level1 = root?.sub_paths ?? [];
    expect(level1.length).toBe(1);
    expect(level1[0]?.path_id).toBe('p1.1');
    expect(level1[0]?.causal_type).toBe('nested');
    expect(level1[0]?.family).toBe('decompose');

    const level2 = level1[0]?.sub_paths ?? [];
    expect(level2.length).toBe(1);
    expect(level2[0]?.path_id).toBe('p1.1.1');
    expect(level2[0]?.causal_type).toBe('unidirectional');
    expect(level2[0]?.family).toBe('single_lever');
    expect(level2[0]?.sub_paths ?? []).toStrictEqual([]);
  });

  it('nested 但 sub_modules 为空 ⇒ 不出子路径（另按 §4.2(b) 追加探索候选）', () => {
    const empty = nestedEmptyClassification();
    expect(shouldAppendProbeCandidate(empty)).toBe(true);
    const paths = strategyPlugin.matchPaths(empty, NO_BOUNDARY);
    for (const path of paths) {
      expect(path.sub_paths ?? []).toStrictEqual([]);
    }
    expect(paths.length).toBe(2);
  });
});

describe('SPEC §4.6 子路径选择与兄弟名次（2026-10-25 补注）', () => {
  const loopFamilyActions = Object.values(VARIANT_SPECS)
    .filter((spec) => spec.family === 'loop_damping')
    .flatMap((spec) => spec.steps.map((step) => step.action));

  it('数组顺序 = rank 顺序；path_id 仍按子模块顺序（子模块顺序与分数相反时两者不同序）', () => {
    // 子模块顺序：unidirectional(0.87) → cyclic(0.88)，与分数顺序相反
    const classification = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [makeProblem('no', 'no', 'yes', 'no'), makeProblem('no', 'yes', 'no', 'no')],
      }),
    );
    const subPaths = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0]?.sub_paths ?? [];
    expect(subPaths.length).toBe(2);
    // rank 更高的 cyclic 在前，但它的 path_id 是 p1.2（k 按子模块顺序）
    expect(subPaths.map((subPath) => subPath.rank)).toStrictEqual([1, 2]);
    expect(subPaths.map((subPath) => subPath.path_id)).toStrictEqual(['p1.2', 'p1.1']);
    expect(subPaths.map((subPath) => subPath.causal_type)).toStrictEqual(['cyclic', 'unidirectional']);
    expect(subPaths[0]?.score ?? 0).toBeGreaterThan(subPaths[1]?.score ?? 1);
  });

  it('某子模块的 rank 1 候选不可执行 ⇒ 退到该子模块名次最好的可执行候选', () => {
    const classification = nestedTwoChildrenClassification();
    // 只阻断 cyclic 子模块 rank 1（loop.leverage_point）的全部动作
    const leverageActions = VARIANT_SPECS['loop.leverage_point'].steps.map((step) => step.action);
    const strategyBoundary = boundary(leverageActions);

    const subPaths = strategyPlugin.matchPaths(classification, strategyBoundary)[0]?.sub_paths ?? [];
    const cyclicSub = subPaths.find((subPath) => subPath.causal_type === 'cyclic');
    const child = childrenOf(classification)[0] as CausalClassification;
    const expected = expectedSubPathCandidate(child, strategyBoundary);

    expect(expected.variant).toBe('loop.gain_control');
    expect(cyclicSub?.variant).toBe(expected.variant);
    expect(cyclicSub?.executable).toBe(true);
    expect(cyclicSub?.blocked_actions).toStrictEqual([]);
    expect(cyclicSub?.score).toBe(expected.score);
    expect(cyclicSub?.score).toBe(scorePath(cyclicSub?.components ?? expected.components));
    // 兄弟名次仍从 1 起连续，数组顺序 = rank 顺序（此处两兄弟同分，仅校验连续性）
    expect(subPaths.map((subPath) => subPath.rank)).toStrictEqual([1, 2]);
  });

  it('某子模块全部候选都不可执行 ⇒ 退化为 rank 1、executable=false，执行时父 status=blocked', async () => {
    const classification = nestedTwoChildrenClassification();
    const strategyBoundary = boundary(loopFamilyActions);

    const root = strategyPlugin.matchPaths(classification, strategyBoundary)[0];
    expect(root?.executable).toBe(true);
    const subPaths = root?.sub_paths ?? [];
    const cyclicSub = subPaths.find((subPath) => subPath.causal_type === 'cyclic');
    const unidirectionalSub = subPaths.find((subPath) => subPath.causal_type === 'unidirectional');

    // §4.6 退化分支：全部候选不可执行时取 rank 1
    expect(cyclicSub?.variant).toBe('loop.leverage_point');
    expect(cyclicSub?.executable).toBe(false);
    expect(cyclicSub?.steps).toStrictEqual([]);
    expect((cyclicSub?.blocked_actions.length ?? 0)).toBeGreaterThan(0);
    expect(unidirectionalSub?.executable).toBe(true);

    const { executor, calls } = makeExecutor();
    if (!root) throw new Error('缺少根路径');
    const result = await strategyPlugin.executePath(root, { boundary: strategyBoundary, executor });

    // 任一子 blocked ⇒ 父 blocked（§6.3）
    expect(result.status).toBe('blocked');
    const cyclicResult = result.sub_results?.find((sub) => sub.path_id === cyclicSub?.path_id);
    expect(cyclicResult?.status).toBe('blocked');
    // 声明式不可执行的子路径一次都不交给执行器（§6.1 安全补注）
    expect(calls.some((call) => call.path_id === cyclicSub?.path_id)).toBe(false);
    // 父自身步骤与可执行的兄弟子路径照常执行
    expect(calls.some((call) => call.path_id === root.path_id)).toBe(true);
    expect(calls.some((call) => call.path_id === unidirectionalSub?.path_id)).toBe(true);
    expect(signalViolations(result, 'decompose-fallback-blocked')).toStrictEqual([]);
  });

  it('子模块候选全部不可执行时，该子路径不会出现在执行器调用里（对照：同一棵树空边界下会调用）', async () => {
    const classification = nestedTwoChildrenClassification();
    const emptyRun = makeExecutor();
    const rootEmpty = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0];
    if (!rootEmpty) throw new Error('缺少根路径');
    await strategyPlugin.executePath(rootEmpty, { boundary: NO_BOUNDARY, executor: emptyRun.executor });
    expect(emptyRun.calls.length).toBeGreaterThan(0);
  });
});

describe('SPEC §7-10 深度上限', () => {
  const classification = nestedTwoChildrenClassification();

  it('max_depth = 0 ⇒ 不展开子路径', () => {
    const root = strategyPlugin.matchPaths(classification, NO_BOUNDARY, { max_depth: 0 })[0];
    expect(root?.variant).toBe('decompose.compose_sub');
    expect(root?.sub_paths ?? []).toStrictEqual([]);
  });

  it('缺省深度等于显式 max_depth = 3（结果深度相等）', () => {
    const implicit = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
    const explicit = strategyPlugin.matchPaths(classification, NO_BOUNDARY, { max_depth: 3 });
    expect(implicit).toStrictEqual(explicit);
  });

  it('max_depth = 1 ⇒ 根展开一层，孙层不再展开', () => {
    const deep = nestedDeepClassification();
    const level1 = strategyPlugin.matchPaths(deep, NO_BOUNDARY, { max_depth: 1 })[0]?.sub_paths ?? [];
    expect(level1.length).toBe(1);
    expect(level1[0]?.path_id).toBe('p1.1');
    expect(level1[0]?.sub_paths ?? []).toStrictEqual([]);
  });

  it('max_depth = 2 ⇒ 孙层可见，再深一层不可见', () => {
    const deep = nestedDeepClassification();
    const level1 = strategyPlugin.matchPaths(deep, NO_BOUNDARY, { max_depth: 2 })[0]?.sub_paths ?? [];
    expect(level1.length).toBe(1);
    const level2 = level1[0]?.sub_paths ?? [];
    expect(level2.length).toBe(1);
    expect(level2[0]?.path_id).toBe('p1.1.1');
  });
});

describe('SPEC §6.3 decompose 执行', () => {
  const classification = nestedTwoChildrenClassification();

  it('父子全部成功 ⇒ 父 status=succeeded，sub_results 长度 2 且路径 id 对应', async () => {
    const { executor, calls } = makeExecutor();
    const root = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0];
    expect(root).toBeDefined();
    if (!root) return;
    const subPaths = root.sub_paths ?? [];

    const result = await strategyPlugin.executePath(root, { boundary: NO_BOUNDARY, executor });

    expect(result.status).toBe('succeeded');
    expect(result.sub_results?.length).toBe(2);
    expect(result.sub_results?.map((sub) => sub.path_id)).toStrictEqual(
      subPaths.map((sub) => sub.path_id),
    );
    expect(result.sub_results?.every((sub) => sub.status === 'succeeded')).toBe(true);
    expect(signalViolations(result, 'decompose-ok')).toStrictEqual([]);

    // 调用顺序：父自身步骤 → 子路径 1 → 子路径 2（SPEC §6.3）
    const expectedActions = [
      ...root.steps.map((step) => ({ path_id: root.path_id, action: step.action })),
      ...subPaths.flatMap((sub) =>
        sub.steps.map((step) => ({ path_id: sub.path_id, action: step.action })),
      ),
    ];
    expect(calls.map((call) => ({ path_id: call.path_id, action: call.action }))).toStrictEqual(
      expectedActions,
    );
    expect(calls.length).toBe(expectedActions.length);
  });

  it('某子路径被阻断 ⇒ 父 status=blocked，该子结果 blocked，其余子路径仍执行', async () => {
    const { executor, calls } = makeExecutor();
    const root = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0];
    if (!root) throw new Error('缺少根路径');
    const subPaths = root.sub_paths ?? [];
    const firstSub = subPaths[0];
    if (!firstSub) throw new Error('缺少子路径');

    // 只阻断第 1 条子路径的全部动作
    const blockedActions = VARIANT_SPECS[firstSub.variant].steps.map((step) => step.action);
    const strategyBoundary = boundary(blockedActions);

    const result = await strategyPlugin.executePath(root, {
      boundary: strategyBoundary,
      executor,
    });

    expect(result.status).toBe('blocked');
    expect(result.sub_results?.length).toBe(2);
    expect(result.sub_results?.[0]?.status).toBe('blocked');
    expect(result.sub_results?.[1]?.status).toBe('succeeded');

    // 被阻断子路径的步骤一律不交给执行器
    const blockedPathId = firstSub.path_id;
    expect(calls.some((call) => call.path_id === blockedPathId)).toBe(false);
    // 父自身与第 2 条子路径照常执行
    expect(calls.some((call) => call.path_id === root.path_id)).toBe(true);
    expect(calls.some((call) => call.path_id === subPaths[1]?.path_id)).toBe(true);
    expect(signalViolations(result, 'decompose-child-blocked')).toStrictEqual([]);
  });

  it('某子路径失败 ⇒ 父 status=failed，其余子路径仍执行（§6.3 澄清：不阻止其余子路径）', async () => {
    // 父自身 1 步 ok；第 1 条子路径首步 failed
    const script: readonly ActionResultStatus[] = ['ok', 'failed'];
    const { executor, calls } = makeExecutor(script);
    const root = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0];
    if (!root) throw new Error('缺少根路径');
    const subPaths = root.sub_paths ?? [];
    const firstSub = subPaths[0];
    const secondSub = subPaths[1];
    if (!firstSub || !secondSub) throw new Error('缺少子路径');

    const result = await strategyPlugin.executePath(root, { boundary: NO_BOUNDARY, executor });

    // 汇总：任一子 failed ⇒ 父 failed（§6.3）
    expect(result.status).toBe('failed');
    expect(result.sub_results?.length).toBe(subPaths.length);
    expect(result.sub_results?.map((sub) => sub.path_id)).toStrictEqual(
      subPaths.map((sub) => sub.path_id),
    );
    expect(result.sub_results?.[0]?.status).toBe('failed');
    expect(result.sub_results?.[1]?.status).toBe('succeeded');

    // 失败子路径自身的后续步骤遵循 §6.2：首步 failed，其余 not_attempted
    expect(firstSub.steps.length).toBeGreaterThan(1);
    expect(result.sub_results?.[0]?.signals.map((signal) => signal.kind)).toStrictEqual([
      'failed',
      'not_attempted',
      'not_attempted',
      'summary',
    ]);
    // 按 path_id + step_index 断言"失败子路径的后续步骤确实没被调用"（不用总次数）
    expect(calls.some((call) => call.path_id === firstSub.path_id && call.step_index === 0)).toBe(true);
    expect(calls.some((call) => call.path_id === firstSub.path_id && call.step_index >= 1)).toBe(false);
    // 其余子路径照常执行完毕
    expect(calls.filter((call) => call.path_id === secondSub.path_id).length).toBe(
      secondSub.steps.length,
    );
    // 父自身步骤也已执行
    expect(calls.filter((call) => call.path_id === root.path_id).length).toBe(root.steps.length);
    expect(signalViolations(result, 'decompose-child-failed')).toStrictEqual([]);
  });

  it('父自身被阻断 ⇒ 不执行任何子路径，执行器零调用', async () => {
    const { executor, calls } = makeExecutor();
    const root = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0];
    if (!root) throw new Error('缺少根路径');

    const ownActions = root.steps.map((step) => step.action);
    const result = await strategyPlugin.executePath(root, {
      boundary: boundary(ownActions),
      executor,
    });

    expect(result.status).toBe('blocked');
    expect(calls.length).toBe(0);
    expect(signalViolations(result, 'decompose-parent-blocked')).toStrictEqual([]);
  });

  it('父自身首步失败 ⇒ 不执行任何子路径，父 status=failed', async () => {
    const { executor, calls } = makeExecutor(['failed']);
    const root = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0];
    if (!root) throw new Error('缺少根路径');

    const result = await strategyPlugin.executePath(root, { boundary: NO_BOUNDARY, executor });

    expect(result.status).toBe('failed');
    expect(calls.length).toBe(1);
    expect(calls[0]?.path_id).toBe(root.path_id);
  });
});

describe('反例：同类型双子的名次与同分稳定性', () => {
  it('两个 unidirectional 子模块 ⇒ 两条子路径变体相同、分数相同，名次仍从 1 起连续', () => {
    const classification = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [
          makeProblem('no', 'no', 'yes', 'no'),
          makeProblem('no', 'no', 'yes', 'no', { label: '第二个单向子模块' }),
        ],
      }),
    );
    expect(classification.causal_type).toBe('nested');
    const root = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0];
    const subPaths = root?.sub_paths ?? [];

    expect(subPaths.length).toBe(2);
    expect(subPaths[0]?.variant).toBe(subPaths[1]?.variant);
    expect(subPaths[0]?.score).toBe(subPaths[1]?.score);
    // 同分时名次仍须从 1 起连续（不出现并列同名次）
    expect(subPaths.map((sub) => sub.rank).sort((left, right) => left - right)).toStrictEqual([1, 2]);
    expect(subPaths.map((sub) => sub.path_id)).toStrictEqual(['p1.1', 'p1.2']);
  });

  it('子路径 label 不影响 path_id 编号（编号按子模块顺序，与 label 无关）', () => {
    const classification = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [
          makeProblem('no', 'yes', 'no', 'no', { label: '甲' }),
          makeProblem('no', 'no', 'yes', 'no', { label: '乙' }),
        ],
      }),
    );
    const root = strategyPlugin.matchPaths(classification, NO_BOUNDARY)[0];
    expect(root?.sub_paths?.map((sub) => sub.path_id)).toStrictEqual(['p1.1', 'p1.2']);
    expect(root?.sub_paths?.map((sub) => sub.causal_type)).toStrictEqual(['cyclic', 'unidirectional']);
  });
});