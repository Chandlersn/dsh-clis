import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { CAUSAL_CLASSIFIER_SERVICE } from '@clis/clis-contracts';
import type { CausalClassifierService } from '@clis/clis-contracts';

import * as classifierPlugin from '@clis/clis-classifier';
import { classifyProblem } from '@clis/clis-classifier';

import { N, Y, problem } from './fixtures';

/**
 * SPEC §2：插件入口三件套与真实 Cordis 装载。
 * 这里验的是"插件面"能否被宿主按 Cordis 规范装载并寻址，而不是判据本身。
 */
describe('插件入口', () => {
  it('导出 name / inject / apply 三件套', () => {
    expect(classifierPlugin.name).toBe('clis-classifier');
    expect(classifierPlugin.inject).toStrictEqual([]);
    expect(typeof classifierPlugin.apply).toBe('function');
  });

  it('装载后可通过服务名取到分类器，且结论与纯函数一致', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);

    const service: CausalClassifierService = ctx[CAUSAL_CLASSIFIER_SERVICE];
    expect(service).toBeDefined();
    expect(typeof service.classify).toBe('function');

    const target = problem(N, Y, N, N, { description: '供需与价格互相影响' });
    const viaService = await service.classify(target);
    expect(viaService).toStrictEqual(classifyProblem(target));
    expect(viaService.causal_type).toBe('cyclic');

    // 服务随 fiber 卸除：关掉上下文后不该再残留。
    await ctx.fiber.dispose();
    expect(ctx[CAUSAL_CLASSIFIER_SERVICE]).toBeUndefined();
  });

  it('服务与纯函数对同一输入给出同样结论（含嵌套子模块）', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);

    const target = problem(N, N, N, Y, {
      description: '多种结构并存',
      sub_problems: [
        problem(N, Y, N, N, { label: '供需环' }),
        problem(N, N, Y, N, { label: '雨→湿' }),
      ],
    });

    const viaService = await ctx[CAUSAL_CLASSIFIER_SERVICE].classify(target);
    expect(viaService).toStrictEqual(classifyProblem(target));
    expect(viaService.sub_modules?.map((module) => module.name)).toStrictEqual(['供需环', '雨→湿']);
    expect(viaService.sub_modules?.map((module) => module.classification.causal_type)).toStrictEqual([
      'cyclic',
      'unidirectional',
    ]);

    await ctx.fiber.dispose();
  });
});