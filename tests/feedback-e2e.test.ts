import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { CAUSAL_FEEDBACK_SERVICE } from '@clis/clis-contracts';
import type { FeedbackRequest } from '@clis/clis-contracts';

import * as feedbackPlugin from '@clis/clis-feedback';
import { detectSignal } from '@clis/clis-feedback';

import {
  blockedResult,
  detectOptions,
  expectSignalInvariants,
  failedResult,
  HISTORICAL_DEVIATIONS,
  request,
  succeededResult,
} from './feedback-helpers';

/** SPEC-feedback §6-7/8：真实 Cordis 装载 + 确定性 + 纯函数性。 */
describe('端到端：真实 Cordis Context', () => {
  it('inject 为空 ⇒ 无需任何其它插件即可装载', async () => {
    const ctx = new Context();
    await ctx.plugin(feedbackPlugin);

    expect(ctx[CAUSAL_FEEDBACK_SERVICE]).toBeDefined();

    await ctx.fiber.dispose();
  });

  it('服务结论与纯函数逐字段相等', async () => {
    const ctx = new Context();
    await ctx.plugin(feedbackPlugin);

    const cases: FeedbackRequest[] = [
      request(succeededResult(), 'cyclic'),
      request(failedResult(), 'unidirectional'),
      request(blockedResult(), 'structural_duality'),
    ];

    for (const target of cases) {
      expect(await ctx[CAUSAL_FEEDBACK_SERVICE].detect(target)).toStrictEqual(detectSignal(target));
    }

    await ctx.fiber.dispose();
  });

  it('带历史轨迹时服务与纯函数一致', async () => {
    const ctx = new Context();
    await ctx.plugin(feedbackPlugin);

    const target = request(failedResult(), 'unidirectional');
    const options = detectOptions(HISTORICAL_DEVIATIONS);

    expect(await ctx[CAUSAL_FEEDBACK_SERVICE].detect(target, options)).toStrictEqual(
      detectSignal(target, options),
    );

    await ctx.fiber.dispose();
  });

  it('卸载后服务消失', async () => {
    const ctx = new Context();
    await ctx.plugin(feedbackPlugin);
    expect(ctx[CAUSAL_FEEDBACK_SERVICE]).toBeDefined();

    await ctx.fiber.dispose();
    expect(ctx[CAUSAL_FEEDBACK_SERVICE]).toBeUndefined();
  });

  it('两个独立 Context 结论一致', async () => {
    const first = new Context();
    const second = new Context();
    await first.plugin(feedbackPlugin);
    await second.plugin(feedbackPlugin);

    const target = request(failedResult(), 'unidirectional');
    const options = detectOptions(HISTORICAL_DEVIATIONS);

    expect(await first[CAUSAL_FEEDBACK_SERVICE].detect(target, options)).toStrictEqual(
      await second[CAUSAL_FEEDBACK_SERVICE].detect(target, options),
    );

    await first.fiber.dispose();
    await second.fiber.dispose();
  });
});

describe('确定性（SPEC §6-8）', () => {
  it('同一输入连续两次 toStrictEqual', () => {
    const inputs: FeedbackRequest[] = [
      request(succeededResult(), 'cyclic'),
      request(failedResult(), 'unidirectional'),
      request(failedResult(), 'cyclic'),
      request(blockedResult(), 'structural_duality'),
    ];

    for (const target of inputs) {
      const options = detectOptions(HISTORICAL_DEVIATIONS);
      expect(detectSignal(target, options)).toStrictEqual(detectSignal(target, options));
    }
  });

  it('不修改入参（深快照）', () => {
    const target = request(failedResult(), 'unidirectional');
    const options = detectOptions(HISTORICAL_DEVIATIONS);
    const targetSnapshot = structuredClone(target);
    const optionsSnapshot = structuredClone(options);

    detectSignal(target, options);

    expect(target).toStrictEqual(targetSnapshot);
    expect(options).toStrictEqual(optionsSnapshot);
  });

  it('无历史与空历史结论一致（缺省等价）', () => {
    const target = request(succeededResult(), 'cyclic');
    expect(detectSignal(target)).toStrictEqual(detectSignal(target, detectOptions([])));
  });
});

describe('信号不变量在真实装载下同样成立', () => {
  it('四种典型输入都满足 evidence 非空 / reason 非空 / 无已执行字段', () => {
    const inputs: FeedbackRequest[] = [
      request(succeededResult(), 'cyclic'),
      request(failedResult(), 'cyclic'),
      request(failedResult(), 'unidirectional'),
      request(blockedResult(), 'structural_duality'),
    ];

    for (const target of inputs) {
      const signal = detectSignal(target, detectOptions(HISTORICAL_DEVIATIONS));
      expectSignalInvariants(signal, 'e2e');
    }
  });

  it('type_misjudged 必须带回退建议，其余信号必不带', () => {
    const misjudged = detectSignal(request(failedResult(), 'unidirectional'), detectOptions(HISTORICAL_DEVIATIONS));
    expect(misjudged.signal_type).toBe('type_misjudged');
    expect(misjudged.suggested_rollback).toBeDefined();

    for (const signal of [
      detectSignal(request(succeededResult(), 'cyclic')),
      detectSignal(request(failedResult(), 'cyclic'), detectOptions([])),
      detectSignal(request(blockedResult(), 'cyclic')),
    ]) {
      expect('suggested_rollback' in signal).toBe(false);
    }
  });
});