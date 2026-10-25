/**
 * 回归：**编排器必须先按 `executable` 过滤再取路径**（SPEC-strategy §4.3 的调用方义务）。
 *
 * 缺陷背景（真实使用中发现，2026-10-25）：
 * SPEC 明确规定 `rank` 只由 score 决定，整条不可执行的路径**不会被自动降级**，
 * 并要求"调用方必须先按 executable 过滤再取 rank 1"。
 * 但 `strategy.match()` 的调用方 —— 编排器的 `run()` / `runRound()` ——
 * 直接按数组顺序取 `paths[pathIndex]`，没有过滤。
 *
 * 后果：被边界剔过步的路径因分数高（score 只算类型匹配与效果，无边界项）
 * 仍排在首位，编排器照单执行，一轮白耗在必然 `blocked` 的路径上。
 *
 * 本用例分别钉住两侧契约：
 * - 策略侧：rank 严格按 score，不因 executable 改变（规格如此，不能"顺手修"）
 * - 编排器侧：执行顺序可执行者优先，不把一轮耗在跑不了的路径上
 */
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import type { CausalClassification, CausalProblem, StrategyBoundary } from '@clis/clis-contracts';
import {
  CAUSAL_ORCHESTRATOR_SERVICE,
  scorePath,
} from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';
import * as feedbackPlugin from '@clis/clis-feedback';
import * as orchestratorPlugin from '@clis/clis-orchestrator';
import * as strategyPlugin from '@clis/clis-strategy';
import { matchPaths } from '@clis/clis-strategy';

/** 单向因果：分数最高的变体是 lever.upstream_trace。 */
const UNIDIRECTIONAL: CausalClassification = {
  causal_type: 'unidirectional',
  confidence: 0.9,
  needs_exploration: false,
  judgment_basis: [],
  evidence: [],
};

const NO_BOUNDARY: StrategyBoundary = { forbidden_actions: [] };

/** 禁掉首选变体的第一个动作，使它不可执行但分数不变。 */
const FORBIDDEN: StrategyBoundary = { forbidden_actions: ['trace_upstream'] };

/** 单向因果的问题（四问里只有 Q3=yes）。 */
const UNIDIRECTIONAL_PROBLEM: CausalProblem = {
  description: '火导致热：严格先后、不可逆',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'no',
    q3_strict_irreversible_order: 'yes',
    q4_coexisting_causal_structures: 'no',
  },
};

/** 装好四插件的上下文。 */
async function makeContext(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(classifierPlugin);
  await ctx.plugin(strategyPlugin);
  await ctx.plugin(feedbackPlugin);
  await ctx.plugin(orchestratorPlugin);
  return ctx;
}

describe('策略侧：rank 严格按 score（规格如此）', () => {
  it('无边界时首选 lever.upstream_trace 且可执行', () => {
    const paths = matchPaths(UNIDIRECTIONAL, NO_BOUNDARY);
    expect(paths[0]?.variant).toBe('lever.upstream_trace');
    expect(paths[0]?.executable).toBe(true);
  });

  it('禁止其动作后，该路径 executable=false 但 rank 仍按 score 不变', () => {
    const baseline = matchPaths(UNIDIRECTIONAL, NO_BOUNDARY);
    const bound = matchPaths(UNIDIRECTIONAL, FORBIDDEN);

    const baselineTarget = baseline.find((path) => path.variant === 'lever.upstream_trace');
    const boundTarget = bound.find((path) => path.variant === 'lever.upstream_trace');

    expect(boundTarget?.executable).toBe(false);
    expect(boundTarget?.blocked_actions.length).toBeGreaterThan(0);

    // SPEC §4.3：rank 只由 score 决定，不可执行不被自动降级
    expect(boundTarget?.score).toBe(baselineTarget?.score);
    expect(boundTarget?.rank).toBe(baselineTarget?.rank);
  });

  it('排序公式可复算：score === scorePath(components)', () => {
    for (const path of matchPaths(UNIDIRECTIONAL, FORBIDDEN)) {
      expect(path.score).toBe(
        scorePath({
          type_fit: path.components.type_fit,
          expected_effect: path.components.expected_effect,
          side_effect_risk: path.components.side_effect_risk,
          execution_cost: path.components.execution_cost,
        }),
      );
    }
  });

  it('rank 从 1 起连续', () => {
    matchPaths(UNIDIRECTIONAL, FORBIDDEN).forEach((path, index) => {
      expect(path.rank).toBe(index + 1);
    });
  });
});

describe('编排器侧：执行顺序可执行者优先', () => {
  it('首选路径不可执行时，编排器不把一轮耗在它上面', async () => {
    // 前提确认：数组首位确实是一条不可执行的路径（缺陷的触发条件）
    const paths = matchPaths(UNIDIRECTIONAL, FORBIDDEN);
    expect(paths[0]?.executable).toBe(false);

    const ctx = await makeContext();
    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(UNIDIRECTIONAL_PROBLEM, {
      boundary: FORBIDDEN,
    });

    // 首轮就跑出结果：没有因为踩到 blocked 路径而多耗一轮
    expect(result.state.traces.length).toBe(1);
    expect(result.outcome).toBe('effective');
    expect(result.execution?.status).toBe('succeeded');

    await ctx.fiber.dispose();
  });

  it('执行的路径是可执行的，不是被边界挡住的那条', async () => {
    const ctx = await makeContext();
    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(UNIDIRECTIONAL_PROBLEM, {
      boundary: FORBIDDEN,
    });

    const executedPathId = result.state.traces[0]?.path_id;
    const paths = matchPaths(UNIDIRECTIONAL, FORBIDDEN);
    const executedPath = paths.find((path) => path.path_id === executedPathId);
    expect(executedPath?.executable).toBe(true);

    await ctx.fiber.dispose();
  });

  it('全部路径都不可执行时，如实报告而不是假装成功', async () => {
    const allActions = matchPaths(UNIDIRECTIONAL, NO_BOUNDARY).flatMap((path) =>
      path.steps.map((step) => step.action),
    );
    const allForbidden: StrategyBoundary = { forbidden_actions: allActions };
    expect(matchPaths(UNIDIRECTIONAL, allForbidden).every((path) => !path.executable)).toBe(true);

    const ctx = await makeContext();
    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(UNIDIRECTIONAL_PROBLEM, {
      boundary: allForbidden,
    });

    expect(result.outcome).not.toBe('effective');

    await ctx.fiber.dispose();
  });
});
