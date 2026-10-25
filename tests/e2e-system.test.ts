import { describe, expect, it } from 'vitest';

import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_ORCHESTRATOR_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  initialState,
} from '@clis/clis-contracts';
import type { OrchestratorState } from '@clis/clis-contracts';

import { bootAll, problem, recordingExecutor, SERVICE_NAMES } from './e2e-harness';

/**
 * 步骤 5 · 端到端验收。
 *
 * 这里验的是**四个插件真的能串成一个闭环**，以及系统级硬约束在真实装载下成立：
 * 生成与判断分离、契约先行、回退上限、震荡锁定、完整 trace。
 */
describe('四插件协同装载', () => {
  it('按顺序装载后四个服务全部可用', async () => {
    const ctx = await bootAll();

    for (const name of SERVICE_NAMES) {
      expect(ctx[name]).toBeDefined();
    }

    await ctx.fiber.dispose();
    for (const name of SERVICE_NAMES) {
      expect(ctx[name]).toBeUndefined();
    }
  });

  it('只装 orchestrator 时它不装载（inject 依赖未满足）', async () => {
    const { Context } = await import('@deepseek-ai/cordis');
    const orchestrator = await import('@clis/clis-orchestrator');

    const ctx = new Context();
    void ctx.plugin(orchestrator);
    expect(ctx[CAUSAL_ORCHESTRATOR_SERVICE]).toBeUndefined();
  });

  it('strategy 依赖 classifier：只装 strategy 时不可用', async () => {
    const { Context } = await import('@deepseek-ai/cordis');
    const strategy = await import('@clis/clis-strategy');

    const ctx = new Context();
    void ctx.plugin(strategy);
    expect(ctx[CAUSAL_STRATEGY_SERVICE]).toBeUndefined();
  });

  it('feedback 无依赖：单独装载即可用', async () => {
    const { Context } = await import('@deepseek-ai/cordis');
    const feedback = await import('@clis/clis-feedback');

    const ctx = new Context();
    await ctx.plugin(feedback);
    expect(ctx[CAUSAL_FEEDBACK_SERVICE]).toBeDefined();
    await ctx.fiber.dispose();
  });
});

describe('闭环：分类 → 策略 → 执行 → 反馈 → 决策', () => {
  it('循环因果问题跑通一轮：类型正确、路径来自 loop 家族、信号 effective、决策 continue', async () => {
    const ctx = await bootAll();
    const executor = recordingExecutor();

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].runRound(problem(), { forbidden_actions: [] }, { executor });

    expect(result.trace.causal_type).toBe('cyclic');
    expect(result.trace.execution_status).toBe('succeeded');
    expect(result.trace.signal_type).toBe('effective');
    expect(result.trace.action).toBe('continue');
    expect(result.decision.action).toBe('continue');

    // 执行器真的被调用过（路径被执行，而不是空转）
    expect(executor.calls.length).toBeGreaterThan(0);
    expect(result.state.traces).toHaveLength(1);

    await ctx.fiber.dispose();
  });

  it('结构对偶问题 ⇒ duality 家族路径被执行', async () => {
    const ctx = await bootAll();
    const executor = recordingExecutor();

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].runRound(
      problem('yes', 'no', 'no', 'no', '正与反同时成立'),
      { forbidden_actions: [] },
      { executor },
    );

    expect(result.trace.causal_type).toBe('structural_duality');
    expect(result.trace.execution_status).toBe('succeeded');

    await ctx.fiber.dispose();
  });

  it('unknown 问题 ⇒ 探索路径，仍能给出决策（不崩）', async () => {
    const ctx = await bootAll();
    const executor = recordingExecutor();

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].runRound(
      problem('unknown', 'unknown', 'unknown', 'unknown', '信息不足'),
      { forbidden_actions: [] },
      { executor },
    );

    expect(result.trace.causal_type).toBe('unknown');
    expect(result.decision.reason.trim().length).toBeGreaterThan(0);

    await ctx.fiber.dispose();
  });

  it('多轮闭环：state 逐轮传递，traces 只增不减', async () => {
    const ctx = await bootAll();
    const executor = recordingExecutor();
    const orchestrator = ctx[CAUSAL_ORCHESTRATOR_SERVICE];

    let state: OrchestratorState = initialState();
    for (let round = 0; round < 3; round += 1) {
      const result = await orchestrator.runRound(problem(), { forbidden_actions: [] }, { executor, state });
      state = result.state;
    }

    expect(state.round).toBe(3);
    expect(state.traces).toHaveLength(3);
    state.traces.forEach((trace, index) => {
      expect(trace.round).toBe(index + 1);
      expect(trace.note.trim().length).toBeGreaterThan(0);
    });

    await ctx.fiber.dispose();
  });
});

describe('系统级硬约束在真实装载下成立', () => {
  it('生成与判断分离：classifier 的结论就是 orchestrator 用的类型，策略不改判', async () => {
    const ctx = await bootAll();
    const executor = recordingExecutor();

    const classification = await ctx[CAUSAL_CLASSIFIER_SERVICE].classify(problem());
    const paths = await ctx[CAUSAL_STRATEGY_SERVICE].match(classification, { forbidden_actions: [] });

    expect(classification.causal_type).toBe('cyclic');
    // 策略产出的每条路径都针对同一个类型 —— 它没有重新判断
    for (const path of paths) {
      expect(path.causal_type).toBe(classification.causal_type);
    }

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].runRound(problem(), { forbidden_actions: [] }, { executor });
    expect(result.trace.causal_type).toBe(classification.causal_type);

    await ctx.fiber.dispose();
  });

  it('边界禁止动作在整条链路上都不被执行', async () => {
    const ctx = await bootAll();
    const executor = recordingExecutor();

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].runRound(
      problem(),
      { forbidden_actions: ['intervene_at_leverage_point'] },
      { executor },
    );

    for (const call of executor.calls) {
      expect(call.action).not.toBe('intervene_at_leverage_point');
    }
    expect(result.trace.note.trim().length).toBeGreaterThan(0);

    await ctx.fiber.dispose();
  });

  it('执行失败时反馈给出非 effective 信号，决策不是 continue', async () => {
    const ctx = await bootAll();
    const executor = recordingExecutor(() => ({ status: 'failed', detail: '执行器回执：失败' }));

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].runRound(
      problem(),
      { forbidden_actions: [] },
      { executor },
    );

    expect(result.trace.execution_status).toBe('failed');
    expect(result.trace.signal_type).not.toBe('effective');
    expect(result.decision.action).not.toBe('continue');

    await ctx.fiber.dispose();
  });
});