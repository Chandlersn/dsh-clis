import { Context, Service } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { CAUSAL_CLASSIFIER_SERVICE, CAUSAL_STRATEGY_SERVICE } from '@clis/clis-contracts';
import type {
  CausalClassification,
  CausalClassifierService,
  CausalProblem,
} from '@clis/clis-contracts';

import * as strategyPlugin from '@clis/clis-strategy';
import { matchPaths } from '@clis/clis-strategy';

import { boundary, makeClassification } from './fixtures';

/** 只用于装载的最小分类器替身：不 import 分类器实现，保持依赖图干净。 */
class FakeClassifier extends Service implements CausalClassifierService {
  constructor(ctx: Context) {
    super(ctx, CAUSAL_CLASSIFIER_SERVICE);
  }

  async classify(_problem: CausalProblem): Promise<CausalClassification> {
    return makeClassification('cyclic');
  }
}

const problem: CausalProblem = {
  description: '任意问题（替身分类器不读它）',
  answers: {
    q1_simultaneous_mutual_definition: 'no',
    q2_delayed_mutual_influence: 'yes',
    q3_strict_irreversible_order: 'no',
    q4_coexisting_causal_structures: 'no',
  },
};

describe('插件入口', () => {
  it('导出 name / inject / apply，且 inject 指向分类器服务名', () => {
    expect(strategyPlugin.name).toBe('clis-strategy');
    expect(strategyPlugin.inject).toStrictEqual([CAUSAL_CLASSIFIER_SERVICE]);
    expect(typeof strategyPlugin.apply).toBe('function');
    expect(strategyPlugin.STRATEGY_LIBRARY_VERSION).toBe('1.0.0');
    expect(strategyPlugin.STRATEGY_LIBRARY.length).toBeGreaterThan(0);
  });

  it('分类器就位后装载：服务可用，match 与纯函数一致，plan 走注入的读取路径', async () => {
    const ctx = new Context();
    await ctx.plugin(FakeClassifier);
    await ctx.plugin(strategyPlugin);

    const service = ctx[CAUSAL_STRATEGY_SERVICE];
    expect(service).toBeDefined();

    const classification = makeClassification('cyclic');
    expect(await service.match(classification, boundary())).toStrictEqual(
      matchPaths(classification, boundary()),
    );

    const planned = await service.plan(problem, boundary());
    expect(planned.map((path) => path.family)).toStrictEqual([
      'loop_damping',
      'loop_damping',
      'loop_damping',
      'loop_damping',
    ]);

    await ctx.fiber.dispose();
    expect(ctx[CAUSAL_STRATEGY_SERVICE]).toBeUndefined();
  });

  it('分类器缺失时策略服务不装载（inject 未满足）', () => {
    const ctx = new Context();
    void ctx.plugin(strategyPlugin);
    expect(ctx[CAUSAL_STRATEGY_SERVICE]).toBeUndefined();
  });
});