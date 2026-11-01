/**
 * 回归：**纯只读路径**不能绕圈空转，也不能把"观测计划"报成"此路不通"。
 *
 * ## 缺陷背景（2026-10-30 真实会话转录复算发现）
 *
 * 前一版早退判据是：
 *
 * ```ts
 * const noChangeAtAll = !producedChange && observedOnly > 0 && blockedSteps > 0;
 * ```
 *
 * 它只覆盖"只读 + 写动作被拦"这一种形态。但策略库里还有一整类
 * **纯只读路径**——它们本来就没有写动作可拦：
 *
 * - `probe.minimal` / `probe.broad`：`probe_environment` + `observe_response`
 * - `decompose.compose_sub`：只有 `partition_sub_modules`
 *
 * 于是 `blockedSteps === 0` 让早退失效，落到 `decide()` 判 `ineffective`
 * → `switch_path` 换到另一条同样纯只读的路径 → 绕满回退上限才认输。
 *
 * **真机证据**：`clis_run` 13 次真实调用中，`nested` 类型 4/4 次返回
 * `outcome=manual_intervention` + `rollback_count=3` + 10 个只读步骤，
 * 对调用方等于"这条路走不通"——而它其实给出了一份完整的观测计划。
 *
 * ## 修法
 *
 * 去掉 `blockedSteps > 0` 的要求；两种结局用两套话术区分：
 * - 有写动作被拦 → 缺**授权**（`allow_writes`）
 * - 纯只读路径   → 缺**数据**（按观测计划采集后回填 `last_outcome`）
 */
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import type { CausalProblem, ExecutionResult } from '@causal-layers/clis-contracts';
import { CAUSAL_ORCHESTRATOR_SERVICE } from '@causal-layers/clis-contracts';
import * as classifierPlugin from '@causal-layers/clis-classifier';
import * as feedbackPlugin from '@causal-layers/clis-feedback';
import * as orchestratorPlugin from '@causal-layers/clis-orchestrator';
import * as strategyPlugin from '@causal-layers/clis-strategy';
import { matchPaths, executePath } from '@causal-layers/clis-strategy';

import { SemiAutoExecutor } from '../packages/clis-plugin/src/executor';

/** nested（拆子模块）：路径只有 partition_sub_modules，天然无写动作。 */
const NESTED_PROBLEM: CausalProblem = {
  description: '三件不同性质的事被混在一起，需要拆开分别处理',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'no',
    q3_strict_irreversible_order: 'no',
    q4_coexisting_causal_structures: 'yes',
  },
};

/** cyclic：路径第 3 步是写动作，会被拦下（对照形态）。 */
const CYCLIC_PROBLEM: CausalProblem = {
  description: 'memory_check 的 R3/R14 警告反复出现，修了又回来',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'yes',
    q3_strict_irreversible_order: 'no',
    q4_coexisting_causal_structures: 'no',
  },
};

const NO_BOUNDARY = { forbidden_actions: [] as string[] };

async function makeContext(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(classifierPlugin);
  await ctx.plugin(strategyPlugin);
  await ctx.plugin(feedbackPlugin);
  await ctx.plugin(orchestratorPlugin);
  return ctx;
}

/** 判断一条路径是否**纯只读**（每一步都放行且都只观测）。 */
async function pathIsPureObservation(ctx: Context, problem: CausalProblem): Promise<boolean> {
  const classification = await ctx['clis.causalClassifier'].classify(problem);
  const paths = matchPaths(classification, NO_BOUNDARY);
  const first = paths.find((item) => item.executable) ?? paths[0];
  if (first === undefined) return false;
  const result: ExecutionResult = await executePath(first, {
    boundary: NO_BOUNDARY,
    executor: new SemiAutoExecutor(),
  });
  const stepSignals = result.signals.filter((item) => item.step_index >= 0);
  return stepSignals.length > 0 && stepSignals.every((item) => item.kind === 'observed_only');
}

describe('纯只读路径：一轮即返回，不绕圈', () => {
  it('nested 类型的首条可执行路径确实不含写动作（前提校验）', async () => {
    const ctx = await makeContext();
    try {
      // 若这条断言挂了，说明策略库变了 —— 本文件的场景就不再复现缺陷。
      expect(await pathIsPureObservation(ctx, NESTED_PROBLEM)).toBe(true);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('纯只读路径 1 轮即返回 manual_intervention（修复前会绕满回退上限）', async () => {
    const ctx = await makeContext();
    try {
      const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(NESTED_PROBLEM, {
        executor: new SemiAutoExecutor(),
      });

      // 关键回归：修复前 traces.length 会等于回退轮数（实测 7）
      expect(result.state.traces.length).toBe(1);
      expect(result.outcome).toBe('manual_intervention');
      expect(result.state.rollback_count).toBe(0);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('纯只读路径的话术指向"采集数据"，不是"需授权"', async () => {
    const ctx = await makeContext();
    try {
      const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(NESTED_PROBLEM, {
        executor: new SemiAutoExecutor(),
      });

      // 它没有写动作被拦，跟调用方要的就不是授权
      expect(result.decision.reason).not.toContain('allow_writes');
      expect(result.reason).toContain('只读观测');
      expect(result.decision.reason).toContain('last_outcome');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('trace 的 note 说明"不含写动作"，而不是"需授权写动作"', async () => {
    const ctx = await makeContext();
    try {
      const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(NESTED_PROBLEM, {
        executor: new SemiAutoExecutor(),
      });
      const note = result.state.traces[0]?.note ?? '';
      expect(note).toContain('纯只读');
      expect(note).not.toContain('需授权');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('纯只读路径不被判 effective（观测≠有进展）', async () => {
    const ctx = await makeContext();
    try {
      const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(NESTED_PROBLEM, {
        executor: new SemiAutoExecutor(),
      });
      expect(result.signal?.signal_type).not.toBe('effective');
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe('写动作被拦的路径：话术仍指向"需授权"（不能被新分支吞掉）', () => {
  it('cyclic 类型（含写动作）仍报 allow_writes', async () => {
    const ctx = await makeContext();
    try {
      const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(CYCLIC_PROBLEM, {
        executor: new SemiAutoExecutor(),
      });
      expect(result.outcome).toBe('manual_intervention');
      expect(result.state.traces.length).toBe(1);
      expect(result.decision.reason).toContain('allow_writes');
      expect(result.reason).toContain('授权');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('cyclic 类型的首条路径确实含写动作（前提校验）', async () => {
    const ctx = await makeContext();
    try {
      expect(await pathIsPureObservation(ctx, CYCLIC_PROBLEM)).toBe(false);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe('真改动的执行器不受影响', () => {
  it('纯只读路径在"真会改"的执行器下判 effective', async () => {
    const ctx = await makeContext();
    try {
      const result = await ctx[CAUSAL_ORCHESTRATOR_SERVICE].run(NESTED_PROBLEM, {
        executor: { execute: async () => ({ status: 'ok', detail: '已施加改动' }) },
      });
      expect(result.outcome).toBe('effective');
      expect(result.state.traces.length).toBe(1);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
