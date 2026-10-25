/**
 * SPEC-strategy §5 边界剔除、§6.1 阻断执行、§7 验证方第 5/6/7 项。
 *
 * 边界的判定一律用契约的 `blockedReason()`（唯一实现），不在此重写规则；
 * 排序分一律用 `scorePath()` 复算。
 */
import { describe, expect, it } from 'vitest';

import { blockedReason, scorePath } from '@clis/clis-contracts';
import type { CandidatePath } from '@clis/clis-contracts';
import * as strategyPlugin from '@clis/clis-strategy';

import {
  ALL_CLASSIFICATIONS,
  NO_BOUNDARY,
  VARIANT_SPECS,
  boundary,
  craftPath,
  craftStep,
  dualityClassification,
  expectedBlockedActions,
  expectedRemainingStepActions,
  makeExecutor,
  pathViolations,
  signalViolations,
} from './strategy-helpers';

const FORBIDDEN_ACTION = 'identify_poles';

function baselinePaths(): readonly CandidatePath[] {
  return strategyPlugin.matchPaths(dualityClassification(), NO_BOUNDARY);
}

function findPath(paths: readonly CandidatePath[], variant: string): CandidatePath | undefined {
  return paths.find((path) => path.variant === variant);
}

describe('SPEC §7-5 不含禁止动作（生成阶段剔除）', () => {
  it('把一个动作放进 forbidden_actions：steps 剔除它、blocked_actions 记录它、executable=false', () => {
    const strategyBoundary = boundary([FORBIDDEN_ACTION]);
    const paths = strategyPlugin.matchPaths(dualityClassification(), strategyBoundary);
    const target = findPath(paths, 'duality.symmetric_mapping');

    expect(target).toBeDefined();
    expect(target?.blocked_actions).toStrictEqual([{ action: FORBIDDEN_ACTION, reason: 'forbidden' }]);
    expect(target?.executable).toBe(false);
    expect(target?.steps.map((step) => step.action)).toStrictEqual(['apply_symmetric_adjustment']);
    // §5：分量与 score 不因剔除而改动
    const baseline = findPath(baselinePaths(), 'duality.symmetric_mapping');
    expect(target?.components).toStrictEqual(baseline?.components);
    expect(target?.score).toBe(baseline?.score);
    expect(target?.score).toBe(scorePath(target?.components ?? { type_fit: 0, expected_effect: 0, side_effect_risk: 0, execution_cost: 0 }));
    // rank 只由 score 决定 ⇒ 不受可达性影响
    expect(target?.rank).toBe(baseline?.rank);

    // 其余路径不受影响
    for (const path of paths) {
      if (path.variant === 'duality.symmetric_mapping') continue;
      expect(path.executable).toBe(true);
      expect(path.blocked_actions).toStrictEqual([]);
    }
    // 没有任何路径的 steps 含被禁止动作
    for (const path of paths) {
      expect(path.steps.some((step) => step.action === FORBIDDEN_ACTION)).toBe(false);
    }
    expect(pathViolations(paths, strategyBoundary, 'forbidden-one')).toStrictEqual([]);
  });

  it('逐变体扫描：禁止该变体全部动作 ⇒ steps 为空、blocked_actions 为其动作（去重）、仍在榜上', () => {
    const violations: string[] = [];
    for (const { name, classification } of ALL_CLASSIFICATIONS) {
      const baseline = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
      for (const basePath of baseline) {
        const actions = VARIANT_SPECS[basePath.variant].steps.map((step) => step.action);
        const strategyBoundary = boundary(actions);
        const paths = strategyPlugin.matchPaths(classification, strategyBoundary);
        const path = findPath(paths, basePath.variant);
        if (!path) {
          violations.push(`${name}/${basePath.variant}: 禁止动作后路径消失`);
          continue;
        }
        if (path.steps.length !== 0) violations.push(`${name}/${basePath.variant}: steps 未清空`);
        const expectedBlocked = expectedBlockedActions(basePath.variant, strategyBoundary);
        if (JSON.stringify(path.blocked_actions) !== JSON.stringify(expectedBlocked)) {
          violations.push(
            `${name}/${basePath.variant}: blocked_actions=${JSON.stringify(path.blocked_actions)} ≠ ${JSON.stringify(expectedBlocked)}`,
          );
        }
        if (path.executable !== false) violations.push(`${name}/${basePath.variant}: executable 应为 false`);
        if (path.score !== basePath.score) violations.push(`${name}/${basePath.variant}: score 被改动`);
        if (path.rank !== basePath.rank) violations.push(`${name}/${basePath.variant}: rank 被改动`);
        if (path.path_id !== basePath.path_id) violations.push(`${name}/${basePath.variant}: path_id 被改动`);
        violations.push(...pathViolations(paths, strategyBoundary, `${name}/${basePath.variant}`));
      }
    }
    expect(violations).toStrictEqual([]);
  });
});

describe('SPEC §7-6 白名单', () => {
  it('allowed_actions 存在时，不在名单内的动作被剔除，reason = not_in_allowlist', () => {
    const strategyBoundary = boundary([], ['apply_symmetric_adjustment']);
    const paths = strategyPlugin.matchPaths(dualityClassification(), strategyBoundary);
    const target = findPath(paths, 'duality.symmetric_mapping');

    expect(target?.steps.map((step) => step.action)).toStrictEqual(['apply_symmetric_adjustment']);
    expect(target?.blocked_actions).toStrictEqual([
      { action: 'identify_poles', reason: 'not_in_allowlist' },
    ]);
    expect(target?.executable).toBe(false);

    // 未列入白名单的动作全部被剔除（该路径两步都不在名单内）
    const relation = findPath(paths, 'duality.relation_tuning');
    expect(relation?.steps).toStrictEqual([]);
    expect(relation?.blocked_actions).toStrictEqual([
      { action: 'measure_relation_parameters', reason: 'not_in_allowlist' },
      { action: 'tune_relation_parameter', reason: 'not_in_allowlist' },
    ]);
    expect(pathViolations(paths, strategyBoundary, 'allowlist')).toStrictEqual([]);
  });

  it('空白名单 ⇒ 所有路径 steps 为空、executable=false，但候选仍在且分数不变', () => {
    const empty = boundary([], []);
    const paths = strategyPlugin.matchPaths(dualityClassification(), empty);
    expect(paths.length).toBe(3);
    for (const path of paths) {
      expect(path.steps).toStrictEqual([]);
      expect(path.executable).toBe(false);
      expect(path.blocked_actions.every((item) => item.reason === 'not_in_allowlist')).toBe(true);
      expect(path.blocked_actions.length).toBe(VARIANT_SPECS[path.variant].steps.length);
    }
    expect(pathViolations(paths, empty, 'empty-allowlist')).toStrictEqual([]);
  });

  it('黑白名单同时命中同一动作时以黑名单为准（reason = forbidden）', () => {
    const strategyBoundary = boundary([FORBIDDEN_ACTION], [
      'identify_poles',
      'apply_symmetric_adjustment',
    ]);
    const paths = strategyPlugin.matchPaths(dualityClassification(), strategyBoundary);
    const target = findPath(paths, 'duality.symmetric_mapping');

    expect(target?.blocked_actions).toStrictEqual([
      { action: FORBIDDEN_ACTION, reason: 'forbidden' },
    ]);
    expect(target?.blocked_actions.some((item) => item.reason === 'not_in_allowlist')).toBe(false);
    expect(target?.steps.map((step) => step.action)).toStrictEqual(['apply_symmetric_adjustment']);

    // 非黑名单但也不在白名单的动作：not_in_allowlist
    const relation = findPath(paths, 'duality.relation_tuning');
    expect(relation?.blocked_actions.every((item) => item.reason === 'not_in_allowlist')).toBe(true);
    expect(pathViolations(paths, strategyBoundary, 'black-over-white')).toStrictEqual([]);
  });

  it('白名单覆盖全部动作时无人被剔除，全部可执行', () => {
    const allActions = VARIANT_SPECS['duality.symmetric_mapping'].steps.map((step) => step.action);
    const strategyBoundary = boundary([], allActions);
    const paths = strategyPlugin.matchPaths(dualityClassification(), strategyBoundary);
    const target = findPath(paths, 'duality.symmetric_mapping');
    expect(target?.executable).toBe(true);
    expect(target?.blocked_actions).toStrictEqual([]);
    expect(target?.steps.map((step) => step.action)).toStrictEqual(
      expectedRemainingStepActions('duality.symmetric_mapping', strategyBoundary),
    );
  });
});

describe('SPEC §7-7 / §6.1：执行阶段绝不把被阻断的动作交给执行器', () => {
  it('手搓态（steps 里真的有禁止动作）⇒ status=blocked、执行器零调用、受阻步骤 skipped_forbidden', async () => {
    const { executor, calls } = makeExecutor();
    const strategyBoundary = boundary([FORBIDDEN_ACTION, 'map_feedback_loop']);
    const path = craftPath({
      steps: [
        craftStep(0, 'apply_symmetric_adjustment', { magnitude: 1, target: 'both_poles' }),
        craftStep(1, FORBIDDEN_ACTION, { pair: 'a/b' }),
        craftStep(2, 'map_feedback_loop', { nodes: 3 }),
      ],
    });

    const result = await strategyPlugin.executePath(path, { boundary: strategyBoundary, executor });

    expect(result.status).toBe('blocked');
    expect(calls.length).toBe(0);
    expect(result.blocked_actions).toStrictEqual([
      { action: FORBIDDEN_ACTION, reason: 'forbidden' },
      { action: 'map_feedback_loop', reason: 'forbidden' },
    ]);
    expect(signalViolations(result, 'hand-crafted-blocked')).toStrictEqual([]);

    const blockedSignals = result.signals.filter((signal) => signal.kind === 'skipped_forbidden');
    expect(blockedSignals.length).toBe(2);
    expect(blockedSignals.map((signal) => signal.step_index)).toStrictEqual([1, 2]);
    expect(blockedSignals.map((signal) => signal.action)).toStrictEqual([
      FORBIDDEN_ACTION,
      'map_feedback_loop',
    ]);

    const notAttempted = result.signals.filter((signal) => signal.kind === 'not_attempted');
    expect(notAttempted.length).toBe(1);
    expect(notAttempted[0]?.step_index).toBe(0);
    expect(notAttempted[0]?.action).toBe('apply_symmetric_adjustment');
    expect((notAttempted[0]?.detail ?? '').length).toBeGreaterThan(0);
  });

  it('禁止动作在白名单外时同样被预检阻断（not_in_allowlist），调用次数 0', async () => {
    const { executor, calls } = makeExecutor();
    const strategyBoundary = boundary([], ['observe_response']);
    const path = craftPath({ steps: [craftStep(0, FORBIDDEN_ACTION, {})] });

    const result = await strategyPlugin.executePath(path, { boundary: strategyBoundary, executor });

    expect(result.status).toBe('blocked');
    expect(calls.length).toBe(0);
    expect(result.blocked_actions).toStrictEqual([
      { action: FORBIDDEN_ACTION, reason: 'not_in_allowlist' },
    ]);
  });

  it('同一被阻断动作出现两次 ⇒ blocked_actions 去重，但每个受阻步骤各记一条信号', async () => {
    const { executor, calls } = makeExecutor();
    const strategyBoundary = boundary([FORBIDDEN_ACTION]);
    const path = craftPath({
      steps: [craftStep(0, FORBIDDEN_ACTION, {}), craftStep(1, FORBIDDEN_ACTION, {})],
    });

    const result = await strategyPlugin.executePath(path, { boundary: strategyBoundary, executor });

    expect(result.status).toBe('blocked');
    expect(calls.length).toBe(0);
    expect(result.blocked_actions.length).toBe(1);
    expect(result.signals.filter((signal) => signal.kind === 'skipped_forbidden').length).toBe(2);
    expect(signalViolations(result, 'duplicate-blocked')).toStrictEqual([]);
  });

  it('无阻断时执行器被调用，且调用参数逐步对应（对照项）', async () => {
    const { executor, calls } = makeExecutor();
    const path = findPath(baselinePaths(), 'duality.symmetric_mapping');
    expect(path).toBeDefined();
    if (!path) return;

    const result = await strategyPlugin.executePath(path, {
      boundary: NO_BOUNDARY,
      executor,
    });

    expect(result.status).toBe('succeeded');
    expect(calls.length).toBe(path.steps.length);
    calls.forEach((call, index) => {
      const step = path.steps[index];
      expect(call.path_id).toBe(path.path_id);
      expect(call.step_index).toBe(step?.index);
      expect(call.action).toBe(step?.action);
      expect(call.params).toStrictEqual(step?.params);
    });
  });
});

describe('SPEC §6.1 安全补注（2026-10-25）：声明式不可执行的路径同样整条不执行', () => {
  const strategyBoundary = boundary([FORBIDDEN_ACTION]);

  function generatedNonExecutablePath(): CandidatePath {
    const paths = strategyPlugin.matchPaths(dualityClassification(), strategyBoundary);
    const path = findPath(paths, 'duality.symmetric_mapping');
    if (!path) throw new Error('缺少被剔除动作的路径');
    return path;
  }

  it('生成态（steps 已剔除、executable=false）⇒ status=blocked、调用次数 0、无 skipped_forbidden', async () => {
    const path = generatedNonExecutablePath();
    expect(path.executable).toBe(false);
    expect(path.blocked_actions).toStrictEqual([{ action: FORBIDDEN_ACTION, reason: 'forbidden' }]);
    // 关键：steps 里已经看不到被禁止的动作（这正是漏洞的成因）
    expect(path.steps.some((step) => step.action === FORBIDDEN_ACTION)).toBe(false);

    const { executor, calls } = makeExecutor();
    const result = await strategyPlugin.executePath(path, { boundary: strategyBoundary, executor });

    expect(result.status).toBe('blocked');
    expect(calls.length).toBe(0);
    expect(result.blocked_actions).toStrictEqual(path.blocked_actions);
    // 这类路径不产生 skipped_forbidden（对应动作已不在 steps 中）
    expect(result.signals.filter((signal) => signal.kind === 'skipped_forbidden').length).toBe(0);
    expect(signalViolations(result, 'declared-blocked')).toStrictEqual([]);
    const last = result.signals[result.signals.length - 1];
    expect(last?.kind).toBe('summary');
    expect((last?.detail ?? '').length).toBeGreaterThan(0);
  });

  it('漏洞探针：即使传入空边界，声明式不可执行的路径也绝不被执行（调用次数 0）', async () => {
    const path = generatedNonExecutablePath();
    // 空边界下 steps 里没有被阻断的动作 ⇒ 只扫 steps 的实现会误判为可执行
    expect(
      path.steps.every((step) => blockedReason(step.action, NO_BOUNDARY) === null),
    ).toBe(true);

    const { executor, calls } = makeExecutor();
    const result = await strategyPlugin.executePath(path, { boundary: NO_BOUNDARY, executor });

    expect(result.status).toBe('blocked');
    expect(calls.length).toBe(0);
    expect(result.signals.filter((signal) => signal.kind === 'skipped_forbidden').length).toBe(0);
    expect(signalViolations(result, 'declared-blocked-empty-boundary')).toStrictEqual([]);
  });

  it('对照：同样输入但边界为空时该路径可执行且真的被跑完', async () => {
    const paths = strategyPlugin.matchPaths(dualityClassification(), NO_BOUNDARY);
    const path = findPath(paths, 'duality.symmetric_mapping');
    if (!path) throw new Error('缺少路径');
    expect(path.executable).toBe(true);

    const { executor, calls } = makeExecutor();
    const result = await strategyPlugin.executePath(path, { boundary: NO_BOUNDARY, executor });

    expect(result.status).toBe('succeeded');
    expect(calls.length).toBe(path.steps.length);
  });
});