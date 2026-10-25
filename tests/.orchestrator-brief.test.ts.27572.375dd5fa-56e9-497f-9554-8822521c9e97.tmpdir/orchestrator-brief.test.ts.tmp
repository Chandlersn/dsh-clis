import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_ORCHESTRATOR_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  ROLLBACK_LIMIT,
  TYPE_LOCK_ROUNDS,
} from '@clis/clis-contracts';
import type { ActionExecutor } from '@clis/clis-contracts';

import * as classifierPlugin from '@clis/clis-classifier';
import * as feedbackPlugin from '@clis/clis-feedback';
import * as orchestratorPlugin from '@clis/clis-orchestrator';
import * as strategyPlugin from '@clis/clis-strategy';

/**
 * 第四插件任务书的逐条验收（Lead 自查，对照用户给出的任务书原文）。
 *
 * 这份用例只验"任务书字面要求"，与 SPEC 的内部细节验收分开，
 * 便于回答"任务书要求的每一条是否真的做到了"。
 */

const problem = {
  description: '任务书验收用问题',
  answers: {
    q1_simultaneous_mutual_definition: 'no' as const,
    q2_delayed_mutual_influence: 'yes' as const,
    q3_strict_irreversible_order: 'no' as const,
    q4_coexisting_causal_structures: 'no' as const,
  },
};

const okExecutor: ActionExecutor = { execute: async () => ({ status: 'ok', detail: 'ok' }) };

describe('任务书 1：插件入口导出 name / inject / apply(ctx)', () => {
  it('三件套齐全', () => {
    expect(orchestratorPlugin.name).toBe('clis-orchestrator');
    expect(Array.isArray(orchestratorPlugin.inject)).toBe(true);
    expect(typeof orchestratorPlugin.apply).toBe('function');
  });
});

describe('任务书 2：注册 OrchestratorService 的实现', () => {
  it('四插件装载后 clis.causalOrchestrator 可用', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    await ctx.plugin(strategyPlugin);
    await ctx.plugin(feedbackPlugin);
    await ctx.plugin(orchestratorPlugin);

    const service = ctx[CAUSAL_ORCHESTRATOR_SERVICE];
    expect(service).toBeDefined();
    expect(typeof service.run).toBe('function');

    await ctx.fiber.dispose();
  });
});

describe('任务书 3：run(problem) 串起五步并跑通闭环', () => {
  it('完整跑通「判断→匹配→执行→反馈→继续」闭环', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    await ctx.plugin(strategyPlugin);
    await ctx.plugin(feedbackPlugin);
    await ctx.plugin(orchestratorPlugin);

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(problem, { executor: okExecutor });

    // 五步都真的发生了
    expect(result.classification.causal_type).toBe('cyclic'); // 判断
    expect(result.execution).toBeDefined(); // 执行
    expect(result.signal).toBeDefined(); // 反馈
    expect(result.decision.reason.trim().length).toBeGreaterThan(0); // 继续/回退决策
    expect(result.outcome).toBe('effective');
    expect(result.state.traces.length).toBeGreaterThanOrEqual(1); // trace

    await ctx.fiber.dispose();
  });
});

describe('任务书 4：回退上限与震荡保护', () => {
  it('回退上限常量就是 3，锁定时长至少 1 轮', () => {
    expect(ROLLBACK_LIMIT).toBe(3);
    expect(TYPE_LOCK_ROUNDS).toBeGreaterThanOrEqual(1);
  });

  it('回退次数超过上限时输出「需人工介入」并记录完整 trace', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    await ctx.plugin(strategyPlugin);
    await ctx.plugin(feedbackPlugin);
    await ctx.plugin(orchestratorPlugin);

    // 执行器一律失败 ⇒ 反复回退，最终触顶
    const failing: ActionExecutor = {
      execute: async () => ({ status: 'failed', detail: '任务书验收：故意失败' }),
    };

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(problem, {
      executor: failing,
      lock_rounds: 0,
      max_rounds: 40,
    });

    expect(result.outcome).toBe('manual_intervention');
    expect(result.reason).toContain('人工介入');
    expect(result.state.rollback_count).toBeLessThanOrEqual(3);
    // 完整 trace：轮数与记录数一致，且每轮 note 非空
    expect(result.state.traces.length).toBe(result.state.round);
    for (const trace of result.state.traces) {
      expect(trace.note.trim().length).toBeGreaterThan(0);
    }

    await ctx.fiber.dispose();
  });
});

describe('任务书 5：依赖注入边界', () => {
  it('inject 恰为三个抽象服务名，且不含实现包', () => {
    expect(orchestratorPlugin.inject).toStrictEqual([
      CAUSAL_CLASSIFIER_SERVICE,
      CAUSAL_STRATEGY_SERVICE,
      CAUSAL_FEEDBACK_SERVICE,
    ]);
    // 只依赖契约包：inject 里不应出现任何 @clis/ 实现包名
    for (const name of orchestratorPlugin.inject) {
      expect(name.startsWith('@clis/')).toBe(false);
    }
  });

  it('三个服务缺失时编排器不装载（证明真的靠 inject）', () => {
    const ctx = new Context();
    void ctx.plugin(orchestratorPlugin);
    expect(ctx[CAUSAL_ORCHESTRATOR_SERVICE]).toBeUndefined();
  });
});