/**
 * SPEC-strategy §2 公开面、§3 策略库、§4 匹配与排序、§7 验证方第 1/2/3/4 项。
 *
 * 所有期望值来自 `docs/SPEC-strategy.md` 与契约包（`scorePath` / `PATH_VARIANTS` /
 * `FAMILY_BY_TYPE`）；排序分一律用契约的 `scorePath()` 复算，不在此重写公式。
 */
import { describe, expect, it } from 'vitest';

import { PATH_SCORE_WEIGHTS, PATH_VARIANTS, scorePath } from '@clis/clis-contracts';
import type { PathScoreComponents, PathVariantId } from '@clis/clis-contracts';
import * as strategyPlugin from '@clis/clis-strategy';

import {
  ALL_CLASSIFICATIONS,
  ALL_SPEC_ACTIONS,
  EXPECTED_LIBRARY_VERSION,
  EXPECTED_VARIANT_VERSION,
  NO_BOUNDARY,
  SPEC_ACTION_COUNT,
  VARIANT_SPECS,
  cyclicClassification,
  dualityClassification,
  dualityExploringClassification,
  expectMatchesOracle,
  expectStepsMatchSpec,
  expectedComponents,
  familyForClassification,
  flattenPaths,
  nestedEmptyClassification,
  nestedExploringWithChildrenClassification,
  nestedTwoChildrenClassification,
  pathViolations,
  shouldAppendProbeCandidate,
  unidirectionalClassification,
  unknownClassification,
} from './strategy-helpers';

const EMPTY_COMPONENTS: PathScoreComponents = {
  type_fit: 0,
  expected_effect: 0,
  side_effect_risk: 0,
  execution_cost: 0,
};

const idNumber = (pathId: string): number =>
  Number((pathId.split('.').pop() ?? '').replace(/^p/, ''));

describe('SPEC §2 公开面与策略库导出', () => {
  it("name === 'clis-strategy'，inject === ['clis.causalClassifier']", () => {
    expect(strategyPlugin.name).toBe('clis-strategy');
    expect(strategyPlugin.inject).toStrictEqual(['clis.causalClassifier']);
  });

  it('apply / StrategyServiceImpl / matchPaths / executePath 均导出且形状正确', () => {
    expect(typeof strategyPlugin.apply).toBe('function');
    expect(typeof strategyPlugin.StrategyServiceImpl).toBe('function');
    expect(typeof strategyPlugin.matchPaths).toBe('function');
    expect(typeof strategyPlugin.executePath).toBe('function');
    expect(strategyPlugin.STRATEGY_LIBRARY_VERSION).toBe(EXPECTED_LIBRARY_VERSION);
  });

  it('STRATEGY_LIBRARY 是数组，含 SPEC §3.1 的全部 14 个变体', () => {
    const library = strategyPlugin.STRATEGY_LIBRARY;
    expect(Array.isArray(library)).toBe(true);
    expect(library.length).toBe(PATH_VARIANTS.length);
    expect(PATH_VARIANTS.length).toBe(14);
    // 条目字段名由实现自定（契约未固定 LibraryVariant 形状），故做形状无关的包含性检查
    const serialized = JSON.stringify(library);
    for (const variant of PATH_VARIANTS) {
      expect(serialized).toContain(variant);
    }
  });

  it('SPEC §4.3：契约权重表即 0.4 / 0.3 / 0.2 / 0.1', () => {
    expect(PATH_SCORE_WEIGHTS.type_fit).toBe(0.4);
    expect(PATH_SCORE_WEIGHTS.expected_effect).toBe(0.3);
    expect(PATH_SCORE_WEIGHTS.side_effect_risk).toBe(0.2);
    expect(PATH_SCORE_WEIGHTS.execution_cost).toBe(0.1);
  });

  it('SPEC §3.2：动作集合共 27 个（用于"动作名取自 §3"的白名单）', () => {
    expect(ALL_SPEC_ACTIONS.length).toBe(SPEC_ACTION_COUNT);
    expect(ALL_SPEC_ACTIONS).toContain('partition_sub_modules');
    expect(ALL_SPEC_ACTIONS).toContain('observe_response');
  });
});

describe('SPEC §4/§7-1/§7-3/§7-4：8 类输入与预言机逐条比对', () => {
  for (const { name, classification } of ALL_CLASSIFICATIONS) {
    it(`${name}：候选集、变体、分量、score、rank、path_id 全部与 SPEC 推算一致`, () => {
      const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);

      expectMatchesOracle(paths, classification);
      expect(pathViolations(paths, NO_BOUNDARY, name)).toStrictEqual([]);
      expect(paths.length).toBeGreaterThan(0);
      // 家族选择（SPEC §4.1）
      expect(paths[0]?.family).toBe(familyForClassification(classification));
      for (const path of paths) {
        expect(path.family).toBe(VARIANT_SPECS[path.variant].family);
      }
    });
  }

  it('§7-1 递归扫描：每条返回路径（含 sub_paths）score === scorePath(components)', () => {
    const violations: string[] = [];
    for (const { name, classification } of ALL_CLASSIFICATIONS) {
      const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
      for (const path of flattenPaths(paths)) {
        const recomputed = scorePath(path.components);
        if (path.score !== recomputed) {
          violations.push(`${name}/${path.path_id}/${path.variant}: ${path.score} ≠ ${recomputed}`);
        }
        const appended =
          path.variant === 'probe.minimal' &&
          familyForClassification(classification) !== 'probe_and_observe';
        if (!appended && path.components.type_fit !== VARIANT_SPECS[path.variant].components.type_fit) {
          violations.push(`${name}/${path.path_id}: components 不得偏离 SPEC §3.1`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('§7-3 rank 从 1 起连续、按 score 降序、score 非增', () => {
    const violations: string[] = [];
    for (const { name, classification } of ALL_CLASSIFICATIONS) {
      const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
      const ranks = paths.map((path) => path.rank).sort((left, right) => left - right);
      const expectedRanks = paths.map((_, index) => index + 1);
      if (ranks.join(',') !== expectedRanks.join(',')) {
        violations.push(`${name}: rank 序列 ${ranks.join(',')}`);
      }
      for (let index = 1; index < paths.length; index += 1) {
        const previous = paths[index - 1];
        const current = paths[index];
        if (previous && current && previous.score < current.score) {
          violations.push(`${name}: score 未非增 ${previous.score} → ${current.score}`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('§7-3 声明顺序一致性（家族内无同分 ⇒ 同分规则由子路径同级用例补足）', () => {
    for (const { name, classification } of ALL_CLASSIFICATIONS) {
      const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
      // 同名次并列在当前 14 个变体的分量下不会出现：先确认这一点
      expect(new Set(paths.map((path) => path.score)).size).toBe(paths.length);
      // path_id 递增方向必须与 PATH_VARIANTS 声明顺序一致
      const byId = [...paths].sort((left, right) => idNumber(left.path_id) - idNumber(right.path_id));
      const declared = PATH_VARIANTS.filter((variant) =>
        byId.some((path) => path.variant === variant),
      );
      expect(byId.map((path) => path.variant)).toStrictEqual([...declared]);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('§7-4 path_id 与 rank 可复现：同一输入两次调用完全一致', () => {
    const violations: string[] = [];
    for (const { name, classification } of ALL_CLASSIFICATIONS) {
      const first = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
      const second = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
      const project = (paths: readonly { path_id: string; rank: number }[]): string =>
        paths.map((path) => `${path.path_id}#${path.rank}`).join('|');
      if (project(first) !== project(second)) {
        violations.push(`${name}: ${project(first)} vs ${project(second)}`);
      }
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        violations.push(`${name}: 两次结论未深度相等`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('§4.5 path_id 按 PATH_VARIANTS 声明顺序编号 p1..pn（与分数无关）', () => {
    const violations: string[] = [];
    for (const { name, classification } of ALL_CLASSIFICATIONS) {
      const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
      const byId = [...paths].sort((left, right) => idNumber(left.path_id) - idNumber(right.path_id));
      const expectedIds = byId.map((_, index) => `p${index + 1}`);
      if (byId.map((path) => path.path_id).join(',') !== expectedIds.join(',')) {
        violations.push(
          `${name}: path_id 序列 ${byId.map((path) => path.path_id).join(',')} ≠ ${expectedIds.join(',')}`,
        );
      }
      const declared = PATH_VARIANTS.filter((variant) =>
        byId.some((path) => path.variant === variant),
      );
      if (byId.map((path) => path.variant).join(',') !== declared.join(',')) {
        violations.push(
          `${name}: id 顺序 ${byId.map((path) => path.variant).join(',')} ≠ 声明顺序 ${declared.join(',')}`,
        );
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('§4.5 path_id 与分数无关：unidirectional 集内 rank 1 不是声明最前者', () => {
    const paths = strategyPlugin.matchPaths(unidirectionalClassification(), NO_BOUNDARY);
    // 声明顺序首项为 lever.upstream_trace；rank 1 应为 lever.necessary_condition
    const rankOne = paths.find((path) => path.rank === 1);
    expect(rankOne?.variant).toBe('lever.necessary_condition');
    const firstDeclared = paths.find((path) => path.variant === 'lever.upstream_trace');
    expect(rankOne).toBeDefined();
    expect(firstDeclared).toBeDefined();
    expect(idNumber(rankOne?.path_id ?? '')).toBeGreaterThan(idNumber(firstDeclared?.path_id ?? ''));
  });
});

describe('SPEC §4.2：低置信度附加探索候选', () => {
  it('已知类型 + needs_exploration ⇒ 追加 probe.minimal（type_fit 0.5）且必排最后', () => {
    const classification = dualityExploringClassification();
    const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);

    expect(paths.length).toBe(4);
    expect(paths[0]?.variant).toBe('duality.symmetric_mapping');
    expect(paths[0]?.components.type_fit).toBe(1.0);
    expect(paths[0]?.rank).toBe(1);

    const appended = paths[paths.length - 1];
    expect(appended?.variant).toBe('probe.minimal');
    expect(appended?.components).toStrictEqual({
      type_fit: 0.5,
      expected_effect: 0.5,
      side_effect_risk: 0.1,
      execution_cost: 0.15,
    });
    expect(appended?.score).toBe(scorePath(appended?.components ?? EMPTY_COMPONENTS));
    expect(appended?.rank).toBe(4);
    expect(appended?.causal_type).toBe('structural_duality');
    expect(appended?.family).toBe('probe_and_observe');
    expect(appended?.path_id).toBe('p4');
    if (appended) expectStepsMatchSpec(appended);
    for (const path of paths.slice(0, 3)) {
      expect(path.components.type_fit).toBe(1.0);
      expect(path.rank).toBeLessThan(4);
    }
    expect(pathViolations(paths, NO_BOUNDARY, 'exploring-known')).toStrictEqual([]);
  });

  it('nested 且 sub_modules 为空 ⇒ 追加 probe.minimal（条件 (b)）', () => {
    const classification = nestedEmptyClassification();
    expect(shouldAppendProbeCandidate(classification)).toBe(true);
    const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
    expect(paths.map((path) => path.variant)).toStrictEqual([
      'decompose.compose_sub',
      'probe.minimal',
    ]);
    expect(paths[1]?.components.type_fit).toBe(0.5);
    expect(paths[1]?.rank).toBe(2);
  });

  it('nested + 探索 + 非空 sub_modules ⇒ 条件 (a) 生效，仍只追加一条', () => {
    const classification = nestedExploringWithChildrenClassification();
    expect((classification.sub_modules ?? []).length).toBe(1);
    expect(shouldAppendProbeCandidate(classification)).toBe(true);
    const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
    const probes = paths.filter((path) => path.variant === 'probe.minimal');
    expect(probes.length).toBe(1);
    expect(paths.length).toBe(2);
    expect(probes[0]?.components.type_fit).toBe(0.5);
  });

  it('nested + 非空 sub_modules 且不探索 ⇒ 不追加任何探索候选', () => {
    const classification = nestedTwoChildrenClassification();
    expect(shouldAppendProbeCandidate(classification)).toBe(false);
    const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
    expect(paths.map((path) => path.variant)).toStrictEqual(['decompose.compose_sub']);
    expect(paths.length).toBe(1);
  });

  it('unknown ⇒ 家族本身即 probe_and_observe，不得重复追加（恰 2 条）', () => {
    const classification = unknownClassification();
    expect(shouldAppendProbeCandidate(classification)).toBe(false);
    const paths = strategyPlugin.matchPaths(classification, NO_BOUNDARY);
    expect(paths.map((path) => path.variant)).toStrictEqual(['probe.minimal', 'probe.broad']);
    expect(paths.length).toBe(2);
    // 家族内变体的 type_fit 取 §3.1 原值 1.0（只有"追加到已知类型"才降为 0.5）
    expect(paths.map((path) => path.components.type_fit)).toStrictEqual([1.0, 1.0]);
  });

  it('非探索的已知类型不追加：duality 3 条、cyclic 4 条、unidirectional 4 条', () => {
    const duality = strategyPlugin.matchPaths(dualityClassification(), NO_BOUNDARY);
    expect(duality.length).toBe(3);
    expect(duality.some((path) => path.variant === 'probe.minimal')).toBe(false);

    const cyclic = strategyPlugin.matchPaths(cyclicClassification(), NO_BOUNDARY);
    expect(cyclic.map((path) => path.variant).sort()).toStrictEqual(
      [
        'loop.leverage_point',
        'loop.delay_tuning',
        'loop.gain_control',
        'loop.damping_injection',
      ].sort(),
    );

    const unidirectional = strategyPlugin.matchPaths(unidirectionalClassification(), NO_BOUNDARY);
    expect(unidirectional.length).toBe(4);
    expect(unidirectional.every((path) => path.family === 'single_lever')).toBe(true);
  });
});

describe('SPEC §7-2：type_fit 优先性', () => {
  it('只差 type_fit 的两个分量组：1.0 的分数严格高于 0.5', () => {
    const high: PathScoreComponents = {
      type_fit: 1.0,
      expected_effect: 0.6,
      side_effect_risk: 0.3,
      execution_cost: 0.4,
    };
    const low: PathScoreComponents = { ...high, type_fit: 0.5 };
    expect(scorePath(high)).toBeGreaterThan(scorePath(low));
    // 传递性：§7-1 已断言实现 score === scorePath(components)，故实现侧排序同向
    const paths = strategyPlugin.matchPaths(nestedEmptyClassification(), NO_BOUNDARY);
    const compose = paths.find((path) => path.variant === 'decompose.compose_sub');
    const appended = paths.find((path) => path.variant === 'probe.minimal');
    expect(compose?.components.type_fit).toBe(1.0);
    expect(appended?.components.type_fit).toBe(0.5);
    expect(compose?.rank ?? 0).toBeLessThan(appended?.rank ?? 0);
    expect(compose?.score ?? 0).toBeGreaterThan(appended?.score ?? 1);
  });

  it('追加候选的分数是候选集最低者，rank 最大', () => {
    const paths = strategyPlugin.matchPaths(dualityExploringClassification(), NO_BOUNDARY);
    const scores = paths.map((path) => path.score);
    expect(paths[paths.length - 1]?.score).toBe(Math.min(...scores));
    expect(paths[paths.length - 1]?.rank).toBe(Math.max(...paths.map((path) => path.rank)));
  });
});

describe('SPEC §3.1/§3.2：分量与步骤逐字一致', () => {
  it('每个变体的 components 与 §3.1 逐字相等（追加到已知类型时按 §3.1 注：type_fit = 0.5）', () => {
    const violations: string[] = [];
    const appendedCount = { value: 0 };
    for (const { name, classification } of ALL_CLASSIFICATIONS) {
      for (const path of strategyPlugin.matchPaths(classification, NO_BOUNDARY)) {
        // 家族自有变体取 §3.1 原值；"低置信度附加候选"按 §3.1 末尾注只把 type_fit 降为 0.5
        const expected = expectedComponents(path.variant, classification);
        const isAppended =
          path.variant === 'probe.minimal' &&
          familyForClassification(classification) !== 'probe_and_observe';
        if (isAppended) {
          appendedCount.value += 1;
          if (expected.type_fit !== 0.5) violations.push(`${name}: 追加态 type_fit 应为 0.5`);
        }
        if (JSON.stringify(path.components) !== JSON.stringify(expected)) {
          violations.push(
            `${name}/${path.variant}: ${JSON.stringify(path.components)} ≠ ${JSON.stringify(expected)}`,
          );
        }
      }
    }
    // 三种追加态输入各出现一次
    expect(appendedCount.value).toBe(3);
    expect(violations).toStrictEqual([]);
  });

  it('14 个变体在 8 类输入中全部出现', () => {
    const seen = new Set<string>();
    for (const { classification } of ALL_CLASSIFICATIONS) {
      for (const path of strategyPlugin.matchPaths(classification, NO_BOUNDARY)) {
        seen.add(path.variant);
      }
    }
    for (const variant of PATH_VARIANTS) {
      expect(seen.has(variant)).toBe(true);
    }
    expect(seen.size).toBe(PATH_VARIANTS.length);
  });

  it('每个变体的 steps 动作序列 / 参数名 / 固定参数 / index / rationale 合规', () => {
    const violations: string[] = [];
    for (const { name, classification } of ALL_CLASSIFICATIONS) {
      for (const path of strategyPlugin.matchPaths(classification, NO_BOUNDARY)) {
        const spec = VARIANT_SPECS[path.variant as PathVariantId];
        const actual = path.steps.map((step) => step.action).join('>');
        const expectedActions = spec.steps.map((step) => step.action).join('>');
        if (actual !== expectedActions) {
          violations.push(`${name}/${path.variant}: ${actual} ≠ ${expectedActions}`);
        }
        try {
          expectStepsMatchSpec(path);
        } catch (error) {
          violations.push(`${name}/${path.variant}: ${String(error)}`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('全库动作名都取自 SPEC §3.2 动作集合（无自然语言忠告式动作）', () => {
    const used = new Set<string>();
    for (const { classification } of ALL_CLASSIFICATIONS) {
      for (const path of strategyPlugin.matchPaths(classification, NO_BOUNDARY)) {
        for (const step of path.steps) used.add(step.action);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const action of used) expect(ALL_SPEC_ACTIONS).toContain(action);
  });

  it('library_version / variant_version 恒为 1.0.0', () => {
    for (const { classification } of ALL_CLASSIFICATIONS) {
      for (const path of strategyPlugin.matchPaths(classification, NO_BOUNDARY)) {
        expect(path.library_version).toBe(EXPECTED_LIBRARY_VERSION);
        expect(path.variant_version).toBe(EXPECTED_VARIANT_VERSION);
      }
    }
  });
});