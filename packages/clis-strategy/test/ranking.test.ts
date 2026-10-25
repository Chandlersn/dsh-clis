import { describe, expect, it } from 'vitest';

import { PATH_VARIANTS, scorePath } from '@clis/clis-contracts';
import type { CausalType } from '@clis/clis-contracts';

import { matchPaths } from '@clis/clis-strategy';

import { allStepActions, boundary, makeClassification } from './fixtures';

const ALL_TYPES: readonly CausalType[] = [
  'structural_duality',
  'cyclic',
  'unidirectional',
  'nested',
  'unknown',
];

describe('排序公式（契约里的唯一实现）', () => {
  it('任何结论下，每条路径的 score 都恰好等于 scorePath(components)', () => {
    for (const type of ALL_TYPES) {
      for (const paths of [
        matchPaths(makeClassification(type), boundary()),
        matchPaths(makeClassification(type, { confidence: 0.5, needs_exploration: true }), boundary()),
        matchPaths(makeClassification(type), boundary(['probe_environment'])),
      ]) {
        for (const path of paths) {
          expect(path.score).toBe(scorePath(path.components));
        }
      }
    }
  });

  it('cyclic：具体名次与分值（0.88 / 0.87 / 0.85 / 0.84）', () => {
    const paths = matchPaths(makeClassification('cyclic'), boundary());

    expect(paths.map((path) => path.path_id)).toStrictEqual(['p1', 'p3', 'p2', 'p4']);
    expect(paths.map((path) => path.variant)).toStrictEqual([
      'loop.leverage_point',
      'loop.gain_control',
      'loop.delay_tuning',
      'loop.damping_injection',
    ]);
    expect(paths.map((path) => path.score)).toStrictEqual([0.88, 0.87, 0.85, 0.84]);
    expect(paths.map((path) => path.rank)).toStrictEqual([1, 2, 3, 4]);
  });

  it('structural_duality：0.89 / 0.87 / 0.85', () => {
    const paths = matchPaths(makeClassification('structural_duality'), boundary());
    expect(paths.map((path) => path.score)).toStrictEqual([0.89, 0.87, 0.85]);
    expect(paths.map((path) => path.rank)).toStrictEqual([1, 2, 3]);
  });

  it('rank 从 1 起连续，且分数不升', () => {
    for (const type of ALL_TYPES) {
      const paths = matchPaths(makeClassification(type), boundary());
      paths.forEach((path, index) => {
        expect(path.rank).toBe(index + 1);
        if (index > 0) {
          const previous = paths[index - 1];
          expect(previous === undefined ? 0 : previous.score).toBeGreaterThanOrEqual(path.score);
        }
      });
    }
  });
});

describe('type_fit 优先', () => {
  it('低置信度时，家族自有候选（type_fit 1.0）全部排在追加的探索候选（type_fit 0.5）之前', () => {
    const paths = matchPaths(
      makeClassification('cyclic', { confidence: 0.66, needs_exploration: true }),
      boundary(),
    );

    expect(paths).toHaveLength(5);
    const probe = paths.at(-1);
    expect(probe?.variant).toBe('probe.minimal');
    expect(probe?.components.type_fit).toBe(0.5);
    expect(probe?.score).toBe(0.62);

    for (const path of paths.slice(0, -1)) {
      expect(path.components.type_fit).toBe(1);
      expect(path.score).toBeGreaterThan(probe?.score ?? 1);
    }
  });

  it('组件只差 type_fit 时，类型更匹配者分数更高（用 scorePath 直接验证）', () => {
    const shared = { expected_effect: 0.9, side_effect_risk: 0.2, execution_cost: 0.4 };
    const matched = scorePath({ ...shared, type_fit: 1 });
    const mismatched = scorePath({ ...shared, type_fit: 0.5 });
    expect(matched).toBe(0.89);
    expect(mismatched).toBe(0.69);
    expect(matched).toBeGreaterThan(mismatched);
  });
});

describe('可复现性与边界', () => {
  it('同一输入两次调用，path_id / rank / score 完全一致', () => {
    for (const type of ALL_TYPES) {
      const once = matchPaths(makeClassification(type), boundary());
      const twice = matchPaths(makeClassification(type), boundary());
      expect(once).toStrictEqual(twice);
    }
  });

  it('path_id 与分数无关：按 PATH_VARIANTS 声明顺序编号', () => {
    const paths = matchPaths(makeClassification('unidirectional'), boundary());
    // single_lever 家族在 PATH_VARIANTS 里的声明顺序
    const familyOrder = PATH_VARIANTS.filter((variant) => variant.startsWith('lever.'));

    const byId = [...paths].sort((left, right) => left.path_id.localeCompare(right.path_id));
    expect(byId.map((path) => path.variant)).toStrictEqual([...familyOrder]);
  });

  it('边界剔除不改变分数：只影响 executable 与 blocked_actions', () => {
    const clean = matchPaths(makeClassification('cyclic'), boundary());
    const gated = matchPaths(makeClassification('cyclic'), boundary(['inject_damping']));

    const cleanScores = clean.map((path) => path.score);
    const gatedScores = gated.map((path) => path.score);
    expect(gatedScores).toStrictEqual(cleanScores);

    const damping = gated.find((path) => path.variant === 'loop.damping_injection');
    expect(damping?.score).toBe(0.84);
    expect(damping?.executable).toBe(false);
    expect(damping?.blocked_actions).toStrictEqual([{ action: 'inject_damping', reason: 'forbidden' }]);
    expect(allStepActions(gated)).not.toContain('inject_damping');
  });

  it('黑名单优先于白名单：同时命中时理由为 forbidden', () => {
    const paths = matchPaths(
      makeClassification('cyclic'),
      boundary(['inject_damping'], ['inject_damping']),
    );

    const damping = paths.find((path) => path.variant === 'loop.damping_injection');
    expect(damping?.blocked_actions).toStrictEqual([{ action: 'inject_damping', reason: 'forbidden' }]);

    const other = paths.find((path) => path.variant === 'loop.leverage_point');
    expect(other?.blocked_actions.every((item) => item.reason === 'not_in_allowlist')).toBe(true);
  });

  it('nested 且无子模块 ⇒ 追加探索候选，保证至少 1 条路径可走', () => {
    const paths = matchPaths(makeClassification('nested'), boundary());
    expect(paths).toHaveLength(2);
    expect(paths.some((path) => path.variant === 'probe.minimal')).toBe(true);
    expect(paths.every((path) => path.executable)).toBe(true);
  });

  it('max_depth = 0 ⇒ 不展开子路径', () => {
    const classification = makeClassification('nested', {
      sub_modules: [
        {
          name: 'sub',
          classification: makeClassification('cyclic'),
        },
      ],
    });

    const shallow = matchPaths(classification, boundary(), { max_depth: 0 });
    expect(shallow[0]?.sub_paths).toBeUndefined();

    const deeper = matchPaths(classification, boundary(), { max_depth: 1 });
    expect(deeper[0]?.sub_paths).toHaveLength(1);
  });
});