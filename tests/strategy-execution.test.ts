/**
 * SPEC-strategy §6 执行与信号、§7 验证方第 8 项，以及 §6.6「不得含回退字段」。
 *
 * 执行器是自建 fake：记录调用序列，从而把"调用次数 / 调用顺序 / 未被喂禁止动作"
 * 变成可断言的硬事实。
 */
import { describe, expect, it } from 'vitest';

import type { ActionResultStatus, CandidatePath, CausalClassification } from '@clis/clis-contracts';
import * as strategyPlugin from '@clis/clis-strategy';

import {
  FORBIDDEN_RESULT_KEY,
  NO_BOUNDARY,
  boundary,
  collectKeys,
  cyclicClassification,
  dualityClassification,
  makeExecutor,
  signalViolations,
} from './strategy-helpers';

function pathOf(classification: CausalClassification, variant: string): CandidatePath {
  const path = strategyPlugin.matchPaths(classification, NO_BOUNDARY).find((item) => item.variant === variant);
  if (!path) throw new Error(`未找到路径 ${variant}`);
  return path;
}

const kinds = (result: { signals: readonly { kind: string }[] }): string[] =>
  result.signals.map((signal) => signal.kind);

describe('SPEC §7-8 成功路径', () => {
  it('全部 ok ⇒ status=succeeded，逐步 observed 信号，调用序列与 steps 一一对应', async () => {
    const { executor, calls } = makeExecutor();
    const path = pathOf(dualityClassification(), 'duality.symmetric_mapping');
    expect(path.steps.length).toBe(2);

    const pending = strategyPlugin.executePath(path, { boundary: NO_BOUNDARY, executor });
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;

    expect(result.path_id).toBe(path.path_id);
    expect(result.status).toBe('succeeded');
    expect(kinds(result)).toStrictEqual(['observed', 'observed', 'summary']);
    expect(signalViolations(result, 'succeeded')).toStrictEqual([]);

    const observed = result.signals.filter((signal) => signal.kind === 'observed');
    expect(observed.length).toBe(path.steps.length);
    observed.forEach((signal, index) => {
      expect(signal.step_index).toBe(path.steps[index]?.index);
      expect(signal.action).toBe(path.steps[index]?.action);
      // detail 取执行器回执（允许包装，但必须含回执内容）
      expect(signal.detail).toContain(`receipt#${index + 1}`);
    });

    expect(result.blocked_actions).toStrictEqual([]);
    expect(calls.length).toBe(path.steps.length);
    expect(calls.map((call) => call.action)).toStrictEqual(path.steps.map((step) => step.action));
  });
});

describe('SPEC §7-8 失败路径（停止后续调用）', () => {
  it('第 2 步 failed ⇒ status=failed，剩余步骤 not_attempted，调用在第 2 步停止', async () => {
    const script: readonly ActionResultStatus[] = ['ok', 'failed'];
    const { executor, calls } = makeExecutor(script);
    // loop.leverage_point 有 3 步
    const path = pathOf(cyclicClassification(), 'loop.leverage_point');
    expect(path.steps.length).toBe(3);

    const result = await strategyPlugin.executePath(path, { boundary: NO_BOUNDARY, executor });

    expect(result.status).toBe('failed');
    expect(kinds(result)).toStrictEqual(['observed', 'failed', 'not_attempted', 'summary']);
    expect(calls.length).toBe(2);
    expect(calls[1]?.step_index).toBe(1);

    const notAttempted = result.signals.filter((signal) => signal.kind === 'not_attempted');
    expect(notAttempted.length).toBe(1);
    expect(notAttempted[0]?.step_index).toBe(2);
    expect(notAttempted[0]?.action).toBe(path.steps[2]?.action);
    expect((notAttempted[0]?.detail ?? '').length).toBeGreaterThan(0);
    expect(signalViolations(result, 'failed-mid')).toStrictEqual([]);
  });

  it('第 1 步就 failed ⇒ 调用次数 1，其余全部 not_attempted', async () => {
    const { executor, calls } = makeExecutor(['failed']);
    const path = pathOf(cyclicClassification(), 'loop.leverage_point');

    const result = await strategyPlugin.executePath(path, { boundary: NO_BOUNDARY, executor });

    expect(result.status).toBe('failed');
    expect(calls.length).toBe(1);
    expect(kinds(result)).toStrictEqual(['failed', 'not_attempted', 'not_attempted', 'summary']);
    expect(result.signals.filter((signal) => signal.kind === 'failed').length).toBe(1);
  });
});

describe('SPEC §6.1 阻断路径（整条不做）', () => {
  it('路径含被阻断动作 ⇒ status=blocked、执行器零调用、受阻步骤 skipped_forbidden、其余 not_attempted', async () => {
    const { executor, calls } = makeExecutor();
    const strategyBoundary = boundary(['identify_poles']);
    const path = pathOf(dualityClassification(), 'duality.symmetric_mapping');

    const result = await strategyPlugin.executePath(path, {
      boundary: strategyBoundary,
      executor,
    });

    expect(result.status).toBe('blocked');
    expect(calls.length).toBe(0);
    expect(kinds(result)).toStrictEqual(['skipped_forbidden', 'not_attempted', 'summary']);
    expect(result.blocked_actions).toStrictEqual([
      { action: 'identify_poles', reason: 'forbidden' },
    ]);

    const skipped = result.signals.filter((signal) => signal.kind === 'skipped_forbidden');
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.step_index).toBe(0);
    expect(skipped[0]?.action).toBe('identify_poles');

    const notAttempted = result.signals.filter((signal) => signal.kind === 'not_attempted');
    expect(notAttempted.length).toBe(1);
    expect(notAttempted[0]?.step_index).toBe(1);
    expect(notAttempted[0]?.action).toBe('apply_symmetric_adjustment');
    expect(signalViolations(result, 'blocked-real-path')).toStrictEqual([]);
  });
});

describe('SPEC §6.4 信号不变量（跨状态）', () => {
  const scenarios: ReadonlyArray<{ name: string; script: readonly ActionResultStatus[]; forbidden: readonly string[] }> = [
    { name: '成功', script: [], forbidden: [] },
    { name: '失败', script: ['ok', 'failed'], forbidden: [] },
    { name: '阻断', script: [], forbidden: ['identify_poles'] },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name}：signals 恒非空、末条 summary(-1/summary)、每条 detail 非空`, async () => {
      const { executor } = makeExecutor(scenario.script);
      const path = pathOf(dualityClassification(), 'duality.symmetric_mapping');
      const result = await strategyPlugin.executePath(path, {
        boundary: boundary(scenario.forbidden),
        executor,
      });

      expect(result.signals.length).toBeGreaterThanOrEqual(path.steps.length + 1);
      expect(signalViolations(result, scenario.name)).toStrictEqual([]);
      const last = result.signals[result.signals.length - 1];
      expect(last?.kind).toBe('summary');
      expect(last?.step_index).toBe(-1);
      expect(last?.action).toBe('summary');
      expect((last?.detail ?? '').length).toBeGreaterThan(0);
      for (const signal of result.signals) expect(signal.detail.length).toBeGreaterThan(0);
    });
  }
});

describe('SPEC §6.6 执行结果不得含回退字段', () => {
  it('三种状态的 ExecutionResult 递归键名都不含 rollback / next_action / suggested', async () => {
    const violations: string[] = [];
    for (const scenario of [
      { name: '成功', script: [] as readonly ActionResultStatus[], forbidden: [] as readonly string[] },
      { name: '失败', script: ['failed'] as readonly ActionResultStatus[], forbidden: [] as readonly string[] },
      { name: '阻断', script: [] as readonly ActionResultStatus[], forbidden: ['identify_poles'] as readonly string[] },
    ]) {
      const { executor } = makeExecutor(scenario.script);
      const path = pathOf(dualityClassification(), 'duality.symmetric_mapping');
      const result = await strategyPlugin.executePath(path, {
        boundary: boundary(scenario.forbidden),
        executor,
      });
      const keys = [...collectKeys(result)];
      for (const key of keys) {
        if (FORBIDDEN_RESULT_KEY.test(key)) violations.push(`${scenario.name}: 结果含字段 ${key}`);
      }
      if (FORBIDDEN_RESULT_KEY.test(JSON.stringify(result))) {
        violations.push(`${scenario.name}: 序列化结果含回退字样`);
      }
    }
    expect(violations).toStrictEqual([]);
  });
});