/**
 * SPEC §2 公开面 + §6 验证方第 11 项 —— 用真实 `@deepseek-ai/cordis` Context 装载插件，
 * 通过服务取到与纯函数 `classifyProblem` 完全相同的结论。
 */
import { Context } from '@deepseek-ai/cordis';
import { CAUSAL_CLASSIFIER_SERVICE, ClisContractError } from '@clis/clis-contracts';
import type { CausalClassifierService, CausalProblem } from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';
import { describe, expect, it } from 'vitest';

import { makeProblem } from './helpers';

const plainProblem = makeProblem('yes', 'no', 'no', 'no', { description: 'e2e 基础' });
const nestedProblem = makeProblem('no', 'no', 'no', 'yes', {
  description: 'e2e 嵌套',
  sub_problems: [makeProblem('no', 'yes', 'no', 'no'), makeProblem('no', 'no', 'yes', 'no')],
});

describe('SPEC §2 公开面逐字匹配', () => {
  it("name === 'clis-classifier'，inject === []", () => {
    expect(classifierPlugin.name).toBe('clis-classifier');
    expect(classifierPlugin.inject).toStrictEqual([]);
  });

  it('apply 是函数；classifyProblem 与 ClassifierService 均导出', () => {
    expect(typeof classifierPlugin.apply).toBe('function');
    expect(typeof classifierPlugin.classifyProblem).toBe('function');
    expect(typeof classifierPlugin.ClassifierService).toBe('function');
  });

  it("契约服务名常量 === 'clis.causalClassifier'", () => {
    expect(CAUSAL_CLASSIFIER_SERVICE).toBe('clis.causalClassifier');
  });

  it('classifyProblem 是同步纯函数（返回值不是 thenable）', () => {
    const result = classifierPlugin.classifyProblem(plainProblem);
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as unknown as { then?: unknown }).then).toBeUndefined();
    expect(result.causal_type).toBe('structural_duality');
  });
});

describe('SPEC §6-11 真实 Cordis Context 端到端', () => {
  it('await ctx.plugin(模块) 后 ctx 上可取得 clis.causalClassifier 服务', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);

    const service = ctx[CAUSAL_CLASSIFIER_SERVICE];
    expect(service).toBeDefined();
    expect(typeof service.classify).toBe('function');

    const viaService = await service.classify(plainProblem);
    const direct = classifierPlugin.classifyProblem(plainProblem);
    expect(viaService).toStrictEqual(direct);
    expect(viaService.causal_type).toBe('structural_duality');
    expect(viaService.confidence).toBe(0.9);
    expect(viaService.needs_exploration).toBe(false);
  });

  it('嵌套输入经服务的结论与纯函数深度相等（含 sub_modules）', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    const service = ctx[CAUSAL_CLASSIFIER_SERVICE];

    const viaService = await service.classify(nestedProblem);
    const direct = classifierPlugin.classifyProblem(nestedProblem);
    expect(viaService).toStrictEqual(direct);
    expect((viaService.sub_modules ?? []).length).toBe(2);
    expect((viaService.sub_modules ?? [])[0]?.classification.causal_type).toBe('cyclic');
    expect((viaService.sub_modules ?? [])[1]?.classification.causal_type).toBe('unidirectional');
  });

  it('服务透传 options.max_depth（max_depth=0 ⇒ sub_modules = []）', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    const service = ctx[CAUSAL_CLASSIFIER_SERVICE];

    const viaService = await service.classify(nestedProblem, { max_depth: 0 });
    expect(viaService.sub_modules).toStrictEqual([]);
    expect(viaService).toStrictEqual(
      classifierPlugin.classifyProblem(nestedProblem, { max_depth: 0 }),
    );
  });

  it("服务可通过 inject(['clis.causalClassifier']) 取到（SPEC §6-11 的 inject 形式）", async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);

    const holder: { service?: CausalClassifierService } = {};
    await ctx.inject([CAUSAL_CLASSIFIER_SERVICE], (scope) => {
      holder.service = scope[CAUSAL_CLASSIFIER_SERVICE];
    });

    expect(holder.service).toBeDefined();
    const viaInject = await (holder.service as CausalClassifierService).classify(plainProblem);
    expect(viaInject).toStrictEqual(classifierPlugin.classifyProblem(plainProblem));
  });

  it('服务对畸形输入以 ClisContractError 拒绝，绝不返回兜底结论', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    const service = ctx[CAUSAL_CLASSIFIER_SERVICE];

    const missingAnswer = {
      description: '',
      answers: {
        q1_simultaneous_mutual_definition: 'yes',
        q2_delayed_mutual_influence: 'no',
        q3_strict_irreversible_order: 'no',
      },
    } as unknown as CausalProblem;

    await expect(service.classify(missingAnswer)).rejects.toBeInstanceOf(ClisContractError);
    await expect(service.classify(missingAnswer)).rejects.toHaveProperty('code', 'INVALID_ANSWERS');

    const validProblemForOptions = {
      description: '',
      answers: {
        q1_simultaneous_mutual_definition: 'yes',
        q2_delayed_mutual_influence: 'no',
        q3_strict_irreversible_order: 'no',
        q4_coexisting_causal_structures: 'no',
      },
    } as unknown as CausalProblem;
    await expect(service.classify(validProblemForOptions, { max_depth: -1 })).rejects.toBeInstanceOf(
      ClisContractError,
    );
    await expect(
      service.classify(validProblemForOptions, { max_depth: 99 }),
    ).rejects.toHaveProperty('code', 'INVALID_OPTIONS');
  });

  it('两次独立装载的服务给出同一结论（服务无隐藏状态）', async () => {
    const first = new Context();
    await first.plugin(classifierPlugin);
    const second = new Context();
    await second.plugin(classifierPlugin);

    const a = await first[CAUSAL_CLASSIFIER_SERVICE].classify(nestedProblem);
    const b = await second[CAUSAL_CLASSIFIER_SERVICE].classify(nestedProblem);
    expect(a).toStrictEqual(b);
  });
});