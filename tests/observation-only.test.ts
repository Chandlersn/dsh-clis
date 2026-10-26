/**
 * 回归：「只观测未改动」不能被判成「有进展」，也不能绕圈空转。
 *
 * 缺陷背景（2026-10-26 真实使用发现，两个独立问题）：
 *
 * **问题一（判定）**：半自动执行器把写动作全拦下、只读动作放行。只读动作返回
 * `status: 'ok'`，strategy 记成 `observed` → 整条路径「全部 observed」→
 * 判 `succeeded` → 反馈判 `effective` → 编排器以为有进展、不换路径。
 *
 * **问题二（空转）**：即使信号修对了，`switch_path` 不消耗回退次数
 * （设计如此：同族换路径算重试不算回退），于是 4 条路径轮完 → 回退重新分类
 * → 再轮 4 条 → …… 共 13 轮才 manual_intervention，期间对系统零改动。
 *
 * 修法：
 * 1. 契约新增 `ActionResult.observationOnly` 与 `observed_only` 信号；
 * 2. 编排器识别「有只读观测但无任何实际改动」→ 立即返回需授权，不再换路径。
 */
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import type {
  ActionExecutor,
  CausalClassification,
  CausalProblem,
  ExecutionResult,
} from '@clis/clis-contracts';
import {
  CAUSAL_ORCHESTRATOR_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  EXECUTION_SIGNAL_KINDS,
} from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';
import * as feedbackPlugin from '@clis/clis-feedback';
import * as orchestratorPlugin from '@clis/clis-orchestrator';
import * as strategyPlugin from '@clis/clis-strategy';
import { matchPaths, executePath } from '@clis/clis-strategy';

import { SemiAutoExecutor } from '../packages/clis-plugin/src/executor';

/** 单向因果，用于取出含多个步骤的真实路径。 */
const UNIDIRECTIONAL: CausalClassification = {
  causal_type: 'unidirectional',
  confidence: 0.9,
  needs_exploration: false,
  judgment_basis: [],
  evidence: [],
};

/** 循环因果（它的路径第 3 步是写动作，正好复现缺陷）。 */
const CYCLIC_PROBLEM: CausalProblem = {
  description: 'memory_check 的 R3/R14 警告反复出现',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'yes',
    q3_strict_irreversible_order: 'no',
    q4_coexisting_causal_structures: 'no',
  },
};

const NO_BOUNDARY = { forbidden_actions: [] as string[] };

/** 只观测不改动的执行器（模拟半自动执行器的只读分支）。 */
const OBSERVE_ONLY: ActionExecutor = {
  execute: async () => ({
    status: 'ok',
    observationOnly: true,
    detail: '只读观测：需采集数据后回填',
  }),
};

/** 真的做了改动的执行器。 */
const DOES_CHANGE: ActionExecutor = {
  execute: async () => ({
    status: 'ok',
    detail: '已施加改动',
  }),
};

/** 恒失败。 */
const FAILING: ActionExecutor = {
  execute: async () => ({ status: 'failed', detail: '失败' }),
};

/** 取一条含至少 2 步的路径。 */
function twoStepPath() {
  const paths = matchPaths(UNIDIRECTIONAL, NO_BOUNDARY);
  const path = paths.find((item) => item.steps.length >= 2) ?? paths[0];
  if (path === undefined) throw new Error('策略库未产出可用路径');
  return path;
}

/** 装好四插件的上下文。 */
async function makeContext(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(classifierPlugin);
  await ctx.plugin(strategyPlugin);
  await ctx.plugin(feedbackPlugin);
  await ctx.plugin(orchestratorPlugin);
  return ctx;
}

describe('契约：新增 observed_only 信号', () => {
  it('EXECUTION_SIGNAL_KINDS 含 observed_only', () => {
    expect(EXECUTION_SIGNAL_KINDS).toContain('observed_only');
  });

  it('原有信号种类都保留（向后兼容）', () => {
    for (const kind of ['observed', 'failed', 'skipped_forbidden', 'not_attempted', 'summary']) {
      expect(EXECUTION_SIGNAL_KINDS).toContain(kind);
    }
  });
});

describe('问题一：只观测未改动不能判 succeeded', () => {
  it('全部步骤只观测 ⇒ status=failed', async () => {
    const result: ExecutionResult = await executePath(twoStepPath(), {
      boundary: NO_BOUNDARY,
      executor: OBSERVE_ONLY,
    });

    expect(result.status).toBe('failed');
  });

  it('步骤信号为 observed_only 而非 observed', async () => {
    const result = await executePath(twoStepPath(), {
      boundary: NO_BOUNDARY,
      executor: OBSERVE_ONLY,
    });

    const stepSignals = result.signals.filter((item) => item.step_index >= 0);
    expect(stepSignals.length).toBeGreaterThan(0);
    expect(stepSignals.every((item) => item.kind === 'observed_only')).toBe(true);
    expect(stepSignals.some((item) => item.kind === 'observed')).toBe(false);
  });

  it('摘要信号说明"仅观测未改动"', async () => {
    const result = await executePath(twoStepPath(), {
      boundary: NO_BOUNDARY,
      executor: OBSERVE_ONLY,
    });

    const summary = result.signals.filter((item) => item.step_index === -1);
    expect(summary.some((item) => item.detail.includes('仅观测'))).toBe(true);
  });

  it('真的改动 ⇒ status=succeeded', async () => {
    const result = await executePath(twoStepPath(), {
      boundary: NO_BOUNDARY,
      executor: DOES_CHANGE,
    });

    expect(result.status).toBe('succeeded');
  });

  it('混合（一步观测 + 一步改动）⇒ succeeded', async () => {
    let call = 0;
    const mixed: ActionExecutor = {
      execute: async () => {
        call += 1;
        return call === 1
          ? { status: 'ok', observationOnly: true, detail: '观测' }
          : { status: 'ok', detail: '改动' };
      },
    };

    const result = await executePath(twoStepPath(), {
      boundary: NO_BOUNDARY,
      executor: mixed,
    });

    expect(result.status).toBe('succeeded');
  });

  it('失败优先于观测：有 failed 步骤时不出 observed_only', async () => {
    const result = await executePath(twoStepPath(), {
      boundary: NO_BOUNDARY,
      executor: FAILING,
    });

    expect(result.status).toBe('failed');
    const stepSignals = result.signals.filter((item) => item.step_index >= 0);
    expect(stepSignals.some((item) => item.kind === 'failed')).toBe(true);
    expect(stepSignals.some((item) => item.kind === 'observed_only')).toBe(false);
  });
});

describe('问题二：半自动模式下不再绕圈空转', () => {
  it('只读+被拦的路径：1 轮即返回 manual_intervention（原来 13 轮）', async () => {
    const ctx = await makeContext();
    const executor = new SemiAutoExecutor();

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(CYCLIC_PROBLEM, { executor });

    // 关键回归：修复前是 13 轮
    expect(result.state.traces.length).toBe(1);
    expect(result.outcome).toBe('manual_intervention');

    await ctx.fiber.dispose();
  });

  it('结论明确指向"需授权"，而不是含糊的"回退耗尽"', async () => {
    const ctx = await makeContext();
    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(CYCLIC_PROBLEM, {
      executor: new SemiAutoExecutor(),
    });

    // 应当告诉调用方要授权写动作，而不是让人以为类型假设有问题
    expect(result.reason).toContain('授权');
    expect(result.decision.reason).toContain('allow_writes');

    await ctx.fiber.dispose();
  });

  it('只读观测不被判 effective', async () => {
    const ctx = await makeContext();
    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(CYCLIC_PROBLEM, {
      executor: new SemiAutoExecutor(),
    });

    expect(result.signal?.signal_type).not.toBe('effective');

    await ctx.fiber.dispose();
  });

  it('有写动作被授权时，正常推进不早退', async () => {
    const ctx = await makeContext();
    // 显式放行该类型路径上的写动作
    const executor = new SemiAutoExecutor({
      allowWrites: ['intervene_at_leverage_point', 'limit_gain', 'shift_delay', 'inject_damping'],
    });

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(CYCLIC_PROBLEM, { executor });

    // 放行后正常走闭环，不该以"需授权"为由早退
    expect(result.reason).not.toContain('授权');
    expect(result.outcome).not.toBe('manual_intervention');

    await ctx.fiber.dispose();
  });

  it('真执行器（非半自动）不受早退影响', async () => {
    const ctx = await makeContext();
    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(CYCLIC_PROBLEM, {
      executor: DOES_CHANGE,
    });

    expect(result.outcome).toBe('effective');
    expect(result.state.traces.length).toBe(1);

    await ctx.fiber.dispose();
  });
});

describe('策略侧仍按路径语义正常产出', () => {
  it('match 与 execute 组合行为不变（回归护栏）', async () => {
    const ctx = await makeContext();
    const classification = await ctx['clis.causalClassifier'].classify(CYCLIC_PROBLEM);
    const paths = await ctx[CAUSAL_STRATEGY_SERVICE].match(classification, NO_BOUNDARY);

    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]?.executable).toBe(true);

    await ctx.fiber.dispose();
  });
});
