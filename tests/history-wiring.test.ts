/**
 * 回归：**历史必须真的到达反馈服务** —— 否则 `type_misjudged` 永不触发。
 *
 * 缺陷背景（2026-10-26 真机审查发现）：
 * 反馈服务是无状态的，靠 `FeedbackHistory.previous_signals` 判断当前偏离
 * 是否属于「反复」。但 orchestrator 的两处 `feedback.detect()` 调用**都没传
 * `options.history`** —— 契约 `RunOptions` 里也没有这个字段。
 * 结果是闭环永远只会判 `ineffective` / `effective`，
 * 契约里那条最关键的 `type_misjudged`（要求「反复」偏离）形同死代码。
 *
 * 本用例钉住链路两端：
 * - 契约层：`RunOptions.history` 存在且被 run() 接受；
 * - 行为层：同一失败在带/不带历史时，信号必须不同。
 */
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import type { ActionExecutor, CausalProblem, FeedbackHistory } from '@clis/clis-contracts';
import { CAUSAL_ORCHESTRATOR_SERVICE } from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';
import * as feedbackPlugin from '@clis/clis-feedback';
import * as orchestratorPlugin from '@clis/clis-orchestrator';
import * as strategyPlugin from '@clis/clis-strategy';

/** 单向因果问题（Q3=yes）—— 该假设下失败会被判类型误判。 */
const UNIDIRECTIONAL_PROBLEM: CausalProblem = {
  description: '火导致热：严格先后且不可逆',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'no',
    q3_strict_irreversible_order: 'yes',
    q4_coexisting_causal_structures: 'no',
  },
};

/** 恒失败的执行器：模拟"干预无效"。 */
const FAILING: ActionExecutor = {
  execute: async () => ({ status: 'failed', detail: '干预后问题依旧' }),
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

describe('历史必须到达反馈服务', () => {
  it('不带历史：重复失败只判 ineffective', async () => {
    const ctx = await makeContext();
    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(UNIDIRECTIONAL_PROBLEM, {
      executor: FAILING,
    });

    // 只看到本轮，无法认定"反复"，故只能是 ineffective
    expect(result.signal?.signal_type).toBe('ineffective');

    await ctx.fiber.dispose();
  });

  it('带历史（同一假设下已两次无效）：升级为 type_misjudged', async () => {
    const ctx = await makeContext();
    const history: FeedbackHistory = {
      previous_signals: ['ineffective', 'ineffective'],
    };

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(UNIDIRECTIONAL_PROBLEM, {
      executor: FAILING,
      history,
    });

    expect(result.signal?.signal_type).toBe('type_misjudged');

    await ctx.fiber.dispose();
  });

  it('带历史时给出回退建议：recheck_type → cyclic', async () => {
    const ctx = await makeContext();
    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(UNIDIRECTIONAL_PROBLEM, {
      executor: FAILING,
      history: { previous_signals: ['ineffective'] },
    });

    const rollback = result.signal?.suggested_rollback;
    expect(rollback).toBeDefined();
    expect(rollback?.kind).toBe('recheck_type');
    // 单向因果反复失败 ⇒ 怀疑其实是回路
    expect(rollback?.target_type).toBe('cyclic');

    await ctx.fiber.dispose();
  });

  it('带历史但假设为 cyclic 且执行失败：同样升级为 type_misjudged', async () => {
    const ctx = await makeContext();
    const cyclicProblem: CausalProblem = {
      description: '供需与价格互相影响，有延迟',
      answers: {
        q1_simultaneous_mutual_definition: 'no',
        q2_delayed_mutual_influence: 'yes',
        q3_strict_irreversible_order: 'no',
        q4_coexisting_causal_structures: 'no',
      },
    };

    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(cyclicProblem, {
      executor: FAILING,
      history: { previous_signals: ['ineffective'] },
    });

    expect(result.signal?.signal_type).toBe('type_misjudged');

    await ctx.fiber.dispose();
  });

  it('历史里只有 effective 时不算反复偏离', async () => {
    const ctx = await makeContext();
    const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(UNIDIRECTIONAL_PROBLEM, {
      executor: FAILING,
      // 此前都成功，这次才失败 —— 不能据此说类型假设错了
      history: { previous_signals: ['effective', 'effective'] },
    });

    expect(result.signal?.signal_type).toBe('ineffective');

    await ctx.fiber.dispose();
  });

  it('runRound 同样接受历史', async () => {
    const ctx = await makeContext();
    const round = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].runRound(
      UNIDIRECTIONAL_PROBLEM,
      { forbidden_actions: [] },
      {
        executor: FAILING,
        history: { previous_signals: ['ineffective', 'ineffective'] },
      },
    );

    expect(round.trace.signal_type).toBe('type_misjudged');

    await ctx.fiber.dispose();
  });
});
