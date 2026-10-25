/**
 * SPEC-strategy §2 公开面 + §7 验证方第 12/13 项 —— 真实 Cordis Context 端到端。
 *
 * 装载顺序按要求：先 clis-classifier，再 clis-strategy（strategy 的 inject 依赖前者）。
 */
import { Context } from '@deepseek-ai/cordis';
import { CAUSAL_STRATEGY_SERVICE, scorePath } from '@clis/clis-contracts';
import type { CausalClassification, CausalProblem, CandidatePath } from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';
import * as strategyPlugin from '@clis/clis-strategy';
import { describe, expect, it } from 'vitest';

import { makeProblem } from './helpers';
import {
  NO_BOUNDARY,
  boundary,
  collectKeys,
  dualityClassification,
  dualityExploringClassification,
  makeExecutor,
  nestedEmptyClassification,
  unknownClassification,
} from './strategy-helpers';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const nestedProblem: CausalProblem = makeProblem('no', 'no', 'no', 'yes', {
  description: 'e2e 嵌套',
  sub_problems: [makeProblem('no', 'yes', 'no', 'no'), makeProblem('no', 'no', 'yes', 'no')],
});

describe('SPEC §7-12 端到端：先装分类器再装策略', () => {
  it('ctx["clis.causalStrategy"] 可用，且 match(...) 与 matchPaths(...) 深度相等', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    await ctx.plugin(strategyPlugin);

    expect(CAUSAL_STRATEGY_SERVICE).toBe('clis.causalStrategy');
    expect(ctx.get(CAUSAL_STRATEGY_SERVICE)).toBeDefined();
    const service = ctx[CAUSAL_STRATEGY_SERVICE];
    expect(typeof service.match).toBe('function');
    expect(typeof service.plan).toBe('function');
    expect(typeof service.execute).toBe('function');

    const archetypes: readonly CausalClassification[] = [
      dualityClassification(),
      dualityExploringClassification(),
      nestedEmptyClassification(),
      unknownClassification(),
    ];
    for (const classification of archetypes) {
      const viaService = await service.match(classification, NO_BOUNDARY);
      const direct = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
      expect(viaService).toStrictEqual(direct);
      for (const path of viaService) {
        expect(path.score).toBe(scorePath(path.components));
      }
    }
  });

  it('带边界的 match 与服务/纯函数三方一致（含被剔除动作的路径）', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    await ctx.plugin(strategyPlugin);
    const service = ctx[CAUSAL_STRATEGY_SERVICE];
    const strategyBoundary = boundary(['identify_poles'], ['identify_poles', 'apply_symmetric_adjustment']);

    const classification = dualityClassification();
    const viaService = await service.match(classification, strategyBoundary);
    const direct = strategyPlugin.matchPaths(classification, strategyBoundary);
    expect(viaService).toStrictEqual(direct);

    const target = viaService.find((path) => path.variant === 'duality.symmetric_mapping');
    expect(target?.executable).toBe(false);
    expect(target?.blocked_actions).toStrictEqual([{ action: 'identify_poles', reason: 'forbidden' }]);
  });

  it('服务 execute(...) 与 executePath(...) 结论深度相等（同一 fake 脚本）', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    await ctx.plugin(strategyPlugin);
    const service = ctx[CAUSAL_STRATEGY_SERVICE];

    const path = strategyPlugin.matchPaths(dualityClassification(), NO_BOUNDARY)[0];
    if (!path) throw new Error('缺少候选路径');

    const viaServiceFake = makeExecutor(['ok', 'failed']);
    const viaFunctionFake = makeExecutor(['ok', 'failed']);

    const viaService = await service.execute(path, {
      boundary: NO_BOUNDARY,
      executor: viaServiceFake.executor,
    });
    const viaFunction = await strategyPlugin.executePath(path, {
      boundary: NO_BOUNDARY,
      executor: viaFunctionFake.executor,
    });

    expect(viaService).toStrictEqual(viaFunction);
    expect(viaService.status).toBe('failed');
    expect(viaServiceFake.calls.length).toBe(viaFunctionFake.calls.length);
    expect([...collectKeys(viaService)].filter((key) => /rollback|next_action/i.test(key))).toStrictEqual([]);
  });

  it('plan(problem, boundary) 通过注入的分类器取类型后返回路径', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    await ctx.plugin(strategyPlugin);
    const service = ctx[CAUSAL_STRATEGY_SERVICE];

    const problem = makeProblem('yes', 'no', 'no', 'no', { description: 'plan 基础' });
    const classification = await ctx['clis.causalClassifier'].classify(problem);
    expect(classification.causal_type).toBe('structural_duality');

    const planned = await service.plan(problem, NO_BOUNDARY);
    expect(planned).toStrictEqual(strategyPlugin.matchPaths(classification, NO_BOUNDARY));
    expect(planned.map((path: CandidatePath) => path.variant)).toStrictEqual([
      'duality.symmetric_mapping',
      'duality.relation_tuning',
      'duality.definition_clarification',
    ]);
  });

  it('plan 透传 ClassifyOptions：max_depth=0 的嵌套分类 ⇒ 追加探索候选（跨插件交互）', async () => {
    const ctx = new Context();
    await ctx.plugin(classifierPlugin);
    await ctx.plugin(strategyPlugin);
    const service = ctx[CAUSAL_STRATEGY_SERVICE];

    const classification = await ctx['clis.causalClassifier'].classify(nestedProblem, { max_depth: 0 });
    expect(classification.causal_type).toBe('nested');
    expect(classification.sub_modules).toStrictEqual([]);

    const planned = await service.plan(nestedProblem, NO_BOUNDARY, { max_depth: 0 });
    expect(planned).toStrictEqual(strategyPlugin.matchPaths(classification, NO_BOUNDARY));
    // sub_modules 为空 ⇒ 按 §4.2(b) 追加 probe.minimal
    expect(planned.map((path) => path.variant)).toStrictEqual(['decompose.compose_sub', 'probe.minimal']);
  });
});

describe('SPEC §7-13 inject 依赖：缺分类器时策略服务不可用', () => {
  it('只装 strategy（不装 classifier）⇒ ctx["clis.causalStrategy"] 不可用；装齐后可用', async () => {
    const ctx = new Context();

    // 依赖未满足：fiber 保持 pending，服务不应出现
    const strategyFiber = ctx.plugin(strategyPlugin);
    await delay(30);
    expect(ctx.get(CAUSAL_STRATEGY_SERVICE)).toBeUndefined();

    // 补齐依赖后自动装载（等待有上限，避免测试挂死）
    await ctx.plugin(classifierPlugin);
    await Promise.race([strategyFiber, delay(500)]);
    expect(ctx.get(CAUSAL_STRATEGY_SERVICE)).toBeDefined();
    expect(typeof ctx[CAUSAL_STRATEGY_SERVICE].match).toBe('function');
  });

  it('两个独立 Context 的服务给出的结论相同（无隐藏状态）', async () => {
    const first = new Context();
    await first.plugin(classifierPlugin);
    await first.plugin(strategyPlugin);
    const second = new Context();
    await second.plugin(classifierPlugin);
    await second.plugin(strategyPlugin);

    const classification = nestedEmptyClassification();
    const a = await first[CAUSAL_STRATEGY_SERVICE].match(classification, NO_BOUNDARY);
    const b = await second[CAUSAL_STRATEGY_SERVICE].match(classification, NO_BOUNDARY);
    expect(a).toStrictEqual(b);
    expect(a).toStrictEqual(strategyPlugin.matchPaths(classification, NO_BOUNDARY));
  });
});