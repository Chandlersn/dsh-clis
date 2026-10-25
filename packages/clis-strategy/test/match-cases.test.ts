import { describe, expect, it } from 'vitest';

import { STRATEGY_FAMILIES } from '@clis/clis-contracts';

import { matchPaths } from '@clis/clis-strategy';

import { allStepActions, boundary, makeClassification, subModule } from './fixtures';

/**
 * SPEC-strategy §7「实现方」要求的匹配用例：
 * 三类确定因果各 ≥2 条，nested 与 unknown 各 ≥1 条。
 * 每条都断言：家族正确 + 至少 1 条候选路径 + 路径步骤不含被禁止的动作。
 */
/**
 * 断言：至少 1 条候选、首选路径属于该家族、家族合法、且任何路径步骤都不含被禁动作。
 * 低置信度时会额外追加探索候选，故不能要求"每条路径都属于该家族"。
 */
function expectMatched(
  paths: ReturnType<typeof matchPaths>,
  family: string,
  forbidden: readonly string[] = [],
): void {
  expect(paths.length).toBeGreaterThanOrEqual(1);
  expect(paths[0]?.family).toBe(family);
  expect(paths.some((path) => path.family === family)).toBe(true);

  for (const path of paths) {
    expect(STRATEGY_FAMILIES).toContain(path.family);
  }

  const actions = allStepActions(paths);
  for (const banned of forbidden) {
    expect(actions).not.toContain(banned);
  }
}

describe('结构对偶 structural_duality', () => {
  it('明确结论 ⇒ 对称映射/关系调优/定义澄清三条候选，家族为 duality_pairing', () => {
    const paths = matchPaths(makeClassification('structural_duality'), boundary());
    expectMatched(paths, 'duality_pairing');
    expect(paths).toHaveLength(3);
    expect(paths.every((path) => path.causal_type === 'structural_duality')).toBe(true);
  });

  it('低置信度 ⇒ 追加一条探索候选，且它排在家族自有候选之后', () => {
    const paths = matchPaths(
      makeClassification('structural_duality', { confidence: 0.66, needs_exploration: true }),
      boundary(),
    );
    expectMatched(paths, 'duality_pairing');
    expect(paths).toHaveLength(4);

    const probe = paths.at(-1);
    expect(probe?.variant).toBe('probe.minimal');
    expect(probe?.family).toBe('probe_and_observe');
    expect(probe?.components.type_fit).toBe(0.5);
  });
});

describe('循环因果 cyclic', () => {
  it('明确结论 ⇒ 杠杆点/延迟调节/增益控制/阻尼注入四条候选，家族为 loop_damping', () => {
    const paths = matchPaths(makeClassification('cyclic'), boundary());
    expectMatched(paths, 'loop_damping');
    expect(paths).toHaveLength(4);
  });

  it('禁止阻尼注入 ⇒ 该动作不出现在任何路径步骤里，且对应路径不可执行', () => {
    const forbidden = ['inject_damping'];
    const paths = matchPaths(makeClassification('cyclic'), boundary(forbidden));
    expectMatched(paths, 'loop_damping', forbidden);

    const damping = paths.find((path) => path.variant === 'loop.damping_injection');
    expect(damping?.blocked_actions).toStrictEqual([
      { action: 'inject_damping', reason: 'forbidden' },
    ]);
    expect(damping?.executable).toBe(false);
    expect(damping?.steps).toStrictEqual([]);
  });
});

describe('单向因果 unidirectional', () => {
  it('明确结论 ⇒ 上游追溯/必要条件/新因果覆盖/不可逆接受四条候选，家族为 single_lever', () => {
    const paths = matchPaths(makeClassification('unidirectional'), boundary());
    expectMatched(paths, 'single_lever');
    expect(paths).toHaveLength(4);
  });

  it('白名单只放行 produce 链上的一步 ⇒ 其余动作全被剔除且理由为不在白名单', () => {
    const paths = matchPaths(
      makeClassification('unidirectional'),
      boundary([], ['trace_upstream']),
    );
    expect(paths).toHaveLength(4);

    for (const path of paths) {
      for (const blocked of path.blocked_actions) {
        expect(blocked.reason).toBe('not_in_allowlist');
      }
    }
    expect(allStepActions(paths)).toStrictEqual(['trace_upstream']);
  });
});

describe('嵌套 nested', () => {
  it('两个子模块 ⇒ 一条 decompose 根路径，两条子路径各对应子模块的类型', () => {
    const classification = makeClassification('nested', {
      sub_modules: [
        subModule('供需环', makeClassification('cyclic')),
        subModule('雨→湿', makeClassification('unidirectional')),
      ],
    });

    const paths = matchPaths(classification, boundary());
    expectMatched(paths, 'decompose');
    expect(paths).toHaveLength(1);

    const root = paths[0];
    expect(root?.sub_paths?.map((sub) => sub.path_id)).toStrictEqual(['p1.1', 'p1.2']);
    expect(root?.sub_paths?.map((sub) => sub.family)).toStrictEqual(['loop_damping', 'single_lever']);
    expect(root?.steps[0]?.action).toBe('partition_sub_modules');
    expect(root?.steps[0]?.params).toStrictEqual({ count: 2 });
  });
});

describe('未知 unknown', () => {
  it('unknown ⇒ 走探索家族，最小与广度两条候选', () => {
    const paths = matchPaths(makeClassification('unknown', { confidence: 0.25 }), boundary());
    expectMatched(paths, 'probe_and_observe');
    expect(paths).toHaveLength(2);
    expect(paths.map((path) => path.variant)).toStrictEqual(['probe.minimal', 'probe.broad']);
  });
});