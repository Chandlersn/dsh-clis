import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { CAUSAL_FEEDBACK_SERVICE, ClisContractError } from '@clis/clis-contracts';
import type { FeedbackRequest } from '@clis/clis-contracts';

import * as feedbackPlugin from '@clis/clis-feedback';
import { detectSignal } from '@clis/clis-feedback';

import { boundary, emptyHistory, request, result } from './fixtures';

describe('插件入口', () => {
  it('导出 name / inject / apply，inject 为空（无法重新分类）', () => {
    expect(feedbackPlugin.name).toBe('clis-feedback');
    expect(feedbackPlugin.inject).toStrictEqual([]);
    expect(typeof feedbackPlugin.apply).toBe('function');
    expect(feedbackPlugin.FEEDBACK_RULES_VERSION).toBe('1.0.0');
  });

  it('无需其它插件即可装载，服务结论与纯函数一致，卸载后消失', async () => {
    const ctx = new Context();
    await ctx.plugin(feedbackPlugin);

    const service = ctx[CAUSAL_FEEDBACK_SERVICE];
    expect(service).toBeDefined();

    const target = request(result('succeeded'), 'cyclic');
    expect(await service.detect(target)).toStrictEqual(detectSignal(target));

    await ctx.fiber.dispose();
    expect(ctx[CAUSAL_FEEDBACK_SERVICE]).toBeUndefined();
  });
});

describe('纯函数性质', () => {
  it('确定性：同一输入两次结论深度相等', () => {
    const target = request(result('failed'), 'unidirectional');
    const options = { history: { previous_signals: ['ineffective'] as const } };
    expect(detectSignal(target, { history: { previous_signals: [...options.history.previous_signals] } }))
      .toStrictEqual(detectSignal(target, { history: { previous_signals: [...options.history.previous_signals] } }));
  });

  it('不修改入参', () => {
    const target = request(result('succeeded'), 'cyclic');
    const snapshot = structuredClone(target);
    detectSignal(target, { history: emptyHistory() });
    expect(target).toStrictEqual(snapshot);
  });

  it('输出不含任何“已执行回退”语义字段', () => {
    const signal = detectSignal(request(result('succeeded'), 'cyclic'));
    for (const forbidden of ['executed', 'applied', 'rollback_performed', 'rolled_back']) {
      expect(Object.keys(signal)).not.toContain(forbidden);
    }
  });
});

describe('输入校验', () => {
  function code(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      if (error instanceof ClisContractError) return error.code;
      throw new Error(`期望 ClisContractError，实际 ${String(error)}`);
    }
    throw new Error('期望抛错但没有');
  }

  it('result 畸形 ⇒ INVALID_RESULT', () => {
    const bad = { result: { status: 'nope', signals: [] }, classification: { causal_type: 'cyclic', confidence: 0.9 }, boundary: boundary() };
    expect(code(() => detectSignal(bad as unknown as FeedbackRequest))).toBe('INVALID_RESULT');

    const badSignals = {
      result: { status: 'succeeded', signals: 'x' },
      classification: { causal_type: 'cyclic', confidence: 0.9 },
      boundary: boundary(),
    };
    expect(code(() => detectSignal(badSignals as unknown as FeedbackRequest))).toBe('INVALID_RESULT');
  });

  it('classification 畸形 ⇒ INVALID_CLASSIFICATION', () => {
    const bad = {
      result: result('succeeded'),
      classification: { causal_type: 'not_a_type', confidence: 0.9 },
      boundary: boundary(),
    };
    expect(code(() => detectSignal(bad as unknown as FeedbackRequest))).toBe('INVALID_CLASSIFICATION');
  });

  it('boundary 畸形 ⇒ INVALID_BOUNDARY', () => {
    const bad = {
      result: result('succeeded'),
      classification: { causal_type: 'cyclic', confidence: 0.9 },
      boundary: { forbidden_actions: 'nope' },
    };
    expect(code(() => detectSignal(bad as unknown as FeedbackRequest))).toBe('INVALID_BOUNDARY');
  });

  it('history 畸形 ⇒ INVALID_OPTIONS', () => {
    const target = request(result('succeeded'), 'cyclic');
    expect(
      code(() => detectSignal(target, { history: { previous_signals: 'x' } as never })),
    ).toBe('INVALID_OPTIONS');
    expect(
      code(() => detectSignal(target, { history: { previous_signals: ['bogus'] } as never })),
    ).toBe('INVALID_OPTIONS');
  });
});