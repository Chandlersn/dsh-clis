import { Context, Service } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_ORCHESTRATOR_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
} from '@clis/clis-contracts';
import type {
  ActionExecutor,
  CausalClassification,
  CausalClassifierService,
  CausalProblem,
  CandidatePath,
  ExecutionResult,
  FeedbackService,
  FeedbackSignal,
  FeedbackSignalType,
  StrategyService,
} from '@clis/clis-contracts';

import * as orchestratorPlugin from '@clis/clis-orchestrator';
import { initialState } from '@clis/clis-orchestrator';

/** 三个服务的 mock —— 用于把编排逻辑与真实实现完全隔离。 */
class MockClassifier extends Service implements CausalClassifierService {
  calls = 0;
  constructor(ctx: Context) {
    super(ctx, CAUSAL_CLASSIFIER_SERVICE);
  }
  async classify(): Promise<CausalClassification> {
    this.calls += 1;
    return {
      causal_type: 'cyclic',
      confidence: 0.9,
      evidence: [{ source: 'RULE', rule_id: 'mock', statement: 'mock', supports: 'cyclic', weight: 1 }],
      judgment_basis: [{ rule_id: 'mock', description: 'mock', fired: true, effect: 'mock' }],
      needs_exploration: false,
    };
  }
}

function makePath(pathId: string): CandidatePath {
  return {
    path_id: pathId,
    variant: 'probe.minimal',
    variant_version: '1.0.0',
    library_version: '1.0.0',
    family: 'probe_and_observe',
    causal_type: 'cyclic',
    steps: [{ index: 0, action: 'probe_environment', params: {}, rationale: '探测' }],
    blocked_actions: [],
    executable: true,
    components: { type_fit: 1, expected_effect: 1, side_effect_risk: 0, execution_cost: 0 },
    score: 1,
    rank: 1,
    summary: 'mock 路径',
  };
}

class MockStrategy extends Service implements StrategyService {
  matchCalls = 0;
  executeCalls = 0;
  constructor(ctx: Context) {
    super(ctx, CAUSAL_STRATEGY_SERVICE);
  }
  async match(): Promise<readonly CandidatePath[]> {
    this.matchCalls += 1;
    return [makePath('p1'), makePath('p2'), makePath('p3')];
  }
  async plan(): Promise<readonly CandidatePath[]> {
    return this.match();
  }
  async execute(path: CandidatePath): Promise<ExecutionResult> {
    this.executeCalls += 1;
    return {
      path_id: path.path_id,
      status: 'failed',
      signals: [
        { path_id: path.path_id, step_index: 0, action: 'probe_environment', kind: 'failed', detail: 'mock 失败' },
        { path_id: path.path_id, step_index: -1, action: 'summary', kind: 'summary', detail: 'mock 汇总' },
      ],
      blocked_actions: [],
    };
  }
}

/** 按预设序列逐轮返回不同信号，用来驱动四种分支。 */
class MockFeedback extends Service implements FeedbackService {
  calls = 0;
  constructor(ctx: Context, private readonly script: readonly FeedbackSignalType[]) {
    super(ctx, CAUSAL_FEEDBACK_SERVICE);
  }
  async detect(): Promise<FeedbackSignal> {
    const index = Math.min(this.calls, this.script.length - 1);
    const signalType = this.script[index] ?? 'effective';
    this.calls += 1;

    const base: {
      signal_type: FeedbackSignalType;
      reason: string;
      evidence: { rule_id: string; statement: string }[];
      assumed_type: 'cyclic';
      suggested_rollback?: { kind: 'recheck_type'; target_type: 'unidirectional'; rationale: string };
    } = {
      signal_type: signalType,
      reason: `mock 信号 ${signalType}`,
      evidence: [{ rule_id: 'mock', statement: 'mock 证据' }],
      assumed_type: 'cyclic',
    };
    if (signalType === 'type_misjudged') {
      base.suggested_rollback = {
        kind: 'recheck_type',
        target_type: 'unidirectional',
        rationale: 'mock 建议',
      };
    }
    return base;
  }
}

const problem: CausalProblem = {
  description: 'mock 问题',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'yes',
    q3_strict_irreversible_order: 'no',
    q4_coexisting_causal_structures: 'no',
  },
};

const okExecutor: ActionExecutor = { execute: async () => ({ status: 'ok', detail: 'ok' }) };

async function boot(script: readonly FeedbackSignalType[]): Promise<{
  ctx: Context;
  orchestrator: ReturnType<Context['plugin']> extends never ? never : NonNullable<Context[typeof CAUSAL_ORCHESTRATOR_SERVICE]>;
  classifier: MockClassifier;
  strategy: MockStrategy;
  feedback: MockFeedback;
}> {
  const ctx = new Context();
  const classifier = new MockClassifier(ctx);
  const strategy = new MockStrategy(ctx);
  const feedback = new MockFeedback(ctx, script);
  await ctx.plugin(orchestratorPlugin);

  return {
    ctx,
    orchestrator: ctx[CAUSAL_ORCHESTRATOR_SERVICE],
    classifier,
    strategy,
    feedback,
  };
}

describe('run(problem)：四种 signal 分支（mock 三服务）', () => {
  it('effective ⇒ 立即返回有效结果，不换路径也不回退', async () => {
    const { ctx, orchestrator, strategy, feedback } = await boot(['effective']);

    const result = await orchestrator.run(problem, { executor: okExecutor });

    expect(result.outcome).toBe('effective');
    expect(result.decision.action).toBe('continue');
    expect(strategy.executeCalls).toBe(1);
    expect(feedback.calls).toBe(1);
    expect(result.state.traces).toHaveLength(1);

    await ctx.fiber.dispose();
  });

  it('ineffective ⇒ 换路径（不换类型），不触发回退', async () => {
    const { ctx, orchestrator, strategy } = await boot(['ineffective', 'effective']);

    const result = await orchestrator.run(problem, { executor: okExecutor });

    expect(result.outcome).toBe('effective');
    expect(result.decision.action).toBe('continue');
    // 第 1 轮 ineffective 换路径，第 2 轮 effective
    expect(strategy.executeCalls).toBe(2);
    expect(result.state.rollback_count).toBe(0);
    // 换路径不需要重新分类
    expect(result.state.traces[0]?.action).toBe('switch_path');

    await ctx.fiber.dispose();
  });

  it('type_misjudged ⇒ 回退到 classifier 重新判断，回退计数 +1', async () => {
    const { ctx, orchestrator, classifier } = await boot(['type_misjudged', 'effective']);

    const result = await orchestrator.run(problem, { executor: okExecutor });

    expect(result.state.traces[0]?.action).toBe('rollback_to_classifier');
    expect(result.state.rollback_count).toBe(1);
    // 首轮分类 + 回退后重新分类
    expect(classifier.calls).toBe(2);
    expect(result.outcome).toBe('effective');

    await ctx.fiber.dispose();
  });

  it('boundary_invalid ⇒ 回退到边界设定，回退计数 +1', async () => {
    const { ctx, orchestrator } = await boot(['boundary_invalid', 'effective']);

    const result = await orchestrator.run(problem, { executor: okExecutor });

    expect(result.state.traces[0]?.action).toBe('rollback_to_boundary');
    expect(result.state.rollback_count).toBe(1);
    expect(result.outcome).toBe('effective');

    await ctx.fiber.dispose();
  });
});

describe('run(problem)：回退上限与震荡保护', () => {
  it('一直 type_misjudged ⇒ 出现锁定轮，且 rollback_count 不超过 3', async () => {
    const { ctx, orchestrator } = await boot(['type_misjudged']);

    const result = await orchestrator.run(problem, { executor: okExecutor });

    // 震荡锁定生效时闭环按设计在锁定期结束本轮（outcome='effective'，表示"继续推进"），
    // 因此这里断言的是"锁定确实发生 + 回退上限从未被突破 + trace 完整"。
    expect(result.state.rollback_count).toBeLessThanOrEqual(3);
    expect(result.state.traces.map((trace) => trace.action)).toContain('lock_and_continue');
    expect(result.state.traces.length).toBe(result.state.round);
    for (const trace of result.state.traces) {
      expect(trace.note.trim().length).toBeGreaterThan(0);
    }

    await ctx.fiber.dispose();
  });

  it('回退上限用尽后必出 manual_intervention（关掉震荡锁定以直达上限）', async () => {
    const { ctx, orchestrator } = await boot(['type_misjudged']);

    // lock_rounds=0 ⇒ 不产生锁定轮，连续回退直达上限
    const result = await orchestrator.run(problem, { executor: okExecutor, lock_rounds: 0 });

    expect(result.outcome).toBe('manual_intervention');
    expect(result.decision.action).toBe('manual_intervention');
    expect(result.state.rollback_count).toBe(3);
    expect(result.reason).toContain('人工介入');

    await ctx.fiber.dispose();
  });

  it('震荡保护：同一类型连续回退时出现 lock_and_continue 轮', async () => {
    const { ctx, orchestrator } = await boot(['type_misjudged']);

    const result = await orchestrator.run(problem, { executor: okExecutor });
    const actions = result.state.traces.map((trace) => trace.action);

    expect(actions).toContain('lock_and_continue');
    // 锁定期不回退：该轮前后 rollback_count 不变
    const lockIndex = actions.indexOf('lock_and_continue');
    expect(result.state.traces[lockIndex]?.rollback_count).toBe(
      result.state.traces[lockIndex - 1]?.rollback_count,
    );

    await ctx.fiber.dispose();
  });

  it('max_rounds 保护：不会无限循环', async () => {
    const { ctx, orchestrator } = await boot(['ineffective']);

    const result = await orchestrator.run(problem, { executor: okExecutor, max_rounds: 4 });

    expect(result.outcome).toBe('manual_intervention');
    expect(result.state.round).toBeLessThanOrEqual(4);

    await ctx.fiber.dispose();
  });
});

describe('run(problem)：编排边界', () => {
  it('编排器不含判据：分类只来自注入的 classifier', async () => {
    const { ctx, orchestrator, classifier } = await boot(['effective']);

    const result = await orchestrator.run(problem, { executor: okExecutor });

    expect(classifier.calls).toBe(1);
    expect(result.classification.causal_type).toBe('cyclic');
    expect(result.state.traces[0]?.causal_type).toBe('cyclic');

    await ctx.fiber.dispose();
  });

  it('起始状态可传入，traces 累加而非重置', async () => {
    const { ctx, orchestrator } = await boot(['effective']);

    const result = await orchestrator.run(problem, {
      executor: okExecutor,
      state: { ...initialState(), round: 5 },
    });

    expect(result.state.round).toBe(6);
    expect(result.state.traces).toHaveLength(1);

    await ctx.fiber.dispose();
  });
});