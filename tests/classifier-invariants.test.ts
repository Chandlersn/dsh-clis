/**
 * SPEC §5 证据不变量、§6 验证方第 1/4/5/6/7/8/10 项：全矩阵预言机扫描、确定性、
 * 嵌套拆分与深度上限。
 *
 * 期望值全部由 `docs/SPEC-classifier.md` 独立推导（见 helpers 的 expectedOutcome）。
 */
import { describe, expect, it } from 'vitest';

import * as classifierPlugin from '@clis/clis-classifier';

import {
  answer4,
  expectedOutcome,
  expectInvariants,
  invariantViolations,
  makeProblem,
  mainRuleEvidence,
  ruleTrace,
} from './helpers';
import type { TriState } from '@clis/clis-contracts';

const STATES: readonly TriState[] = ['yes', 'no', 'unknown'];

interface Combo {
  readonly q1: TriState;
  readonly q2: TriState;
  readonly q3: TriState;
  readonly q4: TriState;
  readonly label: string;
}

function allCombos(): readonly Combo[] {
  const combos: Combo[] = [];
  for (const q1 of STATES) {
    for (const q2 of STATES) {
      for (const q3 of STATES) {
        for (const q4 of STATES) {
          combos.push({ q1, q2, q3, q4, label: `${q1}/${q2}/${q3}/${q4}` });
        }
      }
    }
  }
  return combos;
}

describe('SPEC §6-1 / §4 全矩阵（3^4 = 81 组）预言机扫描', () => {
  it('每组：类型、置信度、探索模式与 SPEC 规则表推算值逐一相等，且不变量全部成立', () => {
    const bad: string[] = [];
    for (const combo of allCombos()) {
      const outcome = expectedOutcome(combo.q1, combo.q2, combo.q3, combo.q4);
      const result = classifierPlugin.classifyProblem(
        makeProblem(combo.q1, combo.q2, combo.q3, combo.q4),
      );

      if (result.causal_type !== outcome.causal_type) {
        bad.push(
          `${combo.label}: causal_type 应为 ${outcome.causal_type}，实际 ${result.causal_type}`,
        );
      }
      if (result.confidence !== outcome.confidence) {
        bad.push(`${combo.label}: confidence 应为 ${outcome.confidence}，实际 ${result.confidence}`);
      }
      if (result.needs_exploration !== outcome.confidence < 0.7) {
        bad.push(
          `${combo.label}: needs_exploration 应为 ${outcome.confidence < 0.7}，实际 ${result.needs_exploration}`,
        );
      }
      bad.push(...invariantViolations(result, combo.label));
    }
    expect(bad).toStrictEqual([]);
  });

  it('陪伴矩阵：同一批作答下 confidence 恒 ∈ (0, 0.9] 且永不等于 1.0', () => {
    const outOfRange: string[] = [];
    for (const combo of allCombos()) {
      const result = classifierPlugin.classifyProblem(
        makeProblem(combo.q1, combo.q2, combo.q3, combo.q4),
      );
      if (!(result.confidence > 0) || result.confidence > 0.9) {
        outOfRange.push(`${combo.label}: confidence = ${result.confidence}`);
      }
      if (result.confidence === 1) {
        outOfRange.push(`${combo.label}: confidence 等于 1.0，违反 §1/§4 R8`);
      }
    }
    expect(outOfRange).toStrictEqual([]);
  });

  it('嵌套根的全矩阵：sub_modules 长度 2 且每个子问题按自身作答独立判定', () => {
    const bad: string[] = [];
    const childAnswers: ReadonlyArray<readonly [TriState, TriState, TriState, TriState]> = [
      ['no', 'yes', 'no', 'no'],
      ['no', 'no', 'yes', 'no'],
    ];
    const children = childAnswers.map(([a, b, c, d]) => makeProblem(a, b, c, d));

    for (const combo of allCombos()) {
      const result = classifierPlugin.classifyProblem(
        makeProblem(combo.q1, combo.q2, combo.q3, combo.q4, { sub_problems: children }),
      );
      const outcome = expectedOutcome(combo.q1, combo.q2, combo.q3, combo.q4);
      if (outcome.causal_type !== 'nested') {
        if (result.sub_modules !== undefined) {
          bad.push(`${combo.label}: 非 nested 不允许出现 sub_modules`);
        }
        continue;
      }
      const subModules = result.sub_modules ?? [];
      if (subModules.length !== 2) {
        bad.push(`${combo.label}: sub_modules 应为 2 项，实际 ${subModules.length}`);
        continue;
      }
      if (subModules.map((module) => module.name).join('|') !== 'sub-1|sub-2') {
        bad.push(`${combo.label}: 无 label 时 name 应为 sub-1/sub-2，实际 ${subModules.map((m) => m.name).join('|')}`);
      }
      childAnswers.forEach(([a, b, c, d], index) => {
        const expected = expectedOutcome(a, b, c, d);
        const actual = subModules[index]?.classification;
        if (!actual) {
          bad.push(`${combo.label}: sub_modules[${index}] 缺失 classification`);
          return;
        }
        if (actual.causal_type !== expected.causal_type) {
          bad.push(
            `${combo.label}: sub_modules[${index}] 类型应为 ${expected.causal_type}，实际 ${actual.causal_type}`,
          );
        }
        if (actual.confidence !== expected.confidence) {
          bad.push(
            `${combo.label}: sub_modules[${index}] confidence 应为 ${expected.confidence}，实际 ${actual.confidence}`,
          );
        }
        bad.push(...invariantViolations(actual, `${combo.label}/sub-${index + 1}`));
      });
    }
    expect(bad).toStrictEqual([]);
  });
});

describe('SPEC §5 证据不变量', () => {
  it('每个 yes 作答恰好产生一条证据：source 为对应 Qn、supports 为对应类型、weight = 1', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'no', 'no', 'yes'));
    const q1 = result.evidence.filter((item) => item.source === 'Q1');
    expect(q1.length).toBe(1);
    expect(q1[0]?.supports).toBe('structural_duality');
    expect(q1[0]?.weight).toBe(1);

    const q4 = result.evidence.filter((item) => item.source === 'Q4');
    expect(q4.length).toBe(1);
    expect(q4[0]?.supports).toBe('nested');
    expect(q4[0]?.weight).toBe(1);

    // 没有作答 yes 的问题不产生 yes 证据
    expect(result.evidence.filter((item) => item.source === 'Q2').length).toBe(0);
    expect(result.evidence.filter((item) => item.source === 'Q3').length).toBe(0);
  });

  it('R4：每个问题各一条"作答状态"证据（supports=unknown、weight=0）', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'no', { description: '有描述' }),
    );
    const stateEvidence = result.evidence.filter(
      (item) => item.source !== 'RULE' && item.source !== 'DESCRIPTION',
    );
    expect(stateEvidence.map((item) => item.source)).toStrictEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    for (const item of stateEvidence) {
      expect(item.supports).toBe('unknown');
      expect(item.weight).toBe(0);
    }
    const description = result.evidence.filter((item) => item.source === 'DESCRIPTION');
    expect(description.length).toBe(1);
    expect(description[0]?.statement).toContain('有描述');
    const last = mainRuleEvidence(result);
    expect(last.source).toBe('RULE');
    expect(last.weight).toBe(0.4);
  });

  it('R4 且 description 为空串时不产生描述证据（§5 仅在非空时追加）', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('no', 'no', 'no', 'no'));
    expect(result.evidence.filter((item) => item.source === 'DESCRIPTION').length).toBe(0);
  });

  it('§5 描述证据截断至 120 字符，超出补 …', () => {
    const longDescription = 'x'.repeat(200);
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'no', { description: longDescription }),
    );
    const description = result.evidence.find((item) => item.source === 'DESCRIPTION');
    expect(description).toBeDefined();
    const statement = description?.statement ?? '';
    expect(statement.includes(`${'x'.repeat(120)}…`)).toBe(true);
    expect(statement.includes('x'.repeat(121))).toBe(false);
  });

  it('短描述整体进入证据，不追加省略号', () => {
    const shortDescription = '短描述';
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'no', { description: shortDescription }),
    );
    const description = result.evidence.find((item) => item.source === 'DESCRIPTION');
    expect(description).toBeDefined();
    expect(description?.statement).toContain(shortDescription);
    expect(description?.statement.includes(`${shortDescription}…`)).toBe(false);
  });

  it('每条证据 statement 恒非空、weight ∈ [0,1]、末尾为 RULE 主判据', () => {
    for (const combo of allCombos()) {
      const result = classifierPlugin.classifyProblem(
        makeProblem(combo.q1, combo.q2, combo.q3, combo.q4, { description: '证据扫描' }),
      );
      expect(result.evidence.length).toBeGreaterThan(0);
      for (const item of result.evidence) {
        expect(typeof item.statement).toBe('string');
        expect(item.statement.length).toBeGreaterThan(0);
        expect(item.weight).toBeGreaterThanOrEqual(0);
        expect(item.weight).toBeLessThanOrEqual(1);
      }
      const last = mainRuleEvidence(result);
      expect(last.source).toBe('RULE');
      expect(last.weight).toBe(result.confidence);
    }
  });
});

describe('SPEC §6-10 确定性', () => {
  const inputs = [
    makeProblem('yes', 'no', 'no', 'no', { description: '确定性 A' }),
    makeProblem('yes', 'yes', 'no', 'no', { description: '确定性 B' }),
    makeProblem('no', 'no', 'no', 'no', { description: '确定性 C' }),
    makeProblem('no', 'no', 'no', 'yes', {
      description: '确定性 D（嵌套）',
      sub_problems: [makeProblem('no', 'yes', 'no', 'no'), makeProblem('no', 'no', 'yes', 'no')],
    }),
  ];

  it('同一输入连续两次 classifyProblem 结果深度相等（toStrictEqual）', () => {
    for (const input of inputs) {
      const first = classifierPlugin.classifyProblem(input);
      const second = classifierPlugin.classifyProblem(input);
      expect(first).toStrictEqual(second);
    }
  });

  it('classifyProblem 是纯函数：不修改入参（调用后与快照深度相等）', () => {
    for (const input of inputs) {
      const snapshot = structuredClone(input);
      classifierPlugin.classifyProblem(input);
      expect(input).toStrictEqual(snapshot);
    }
  });

  it('同一输入在 81 组扫描中重复可复现（抽样三次深度相等）', () => {
    const sample = makeProblem('no', 'unknown', 'unknown', 'yes', {
      description: '抽样',
      sub_problems: [makeProblem('yes', 'yes', 'no', 'no')],
    });
    expect(classifierPlugin.classifyProblem(sample)).toStrictEqual(
      classifierPlugin.classifyProblem(sample),
    );
    expect(classifierPlugin.classifyProblem(sample)).toStrictEqual(
      classifierPlugin.classifyProblem(sample),
    );
  });
});

describe('SPEC §4.3 / §6-6/7/8 嵌套拆分与深度上限', () => {
  const cyclicChild = makeProblem('no', 'yes', 'no', 'no');
  const unidirectionalChild = makeProblem('no', 'no', 'yes', 'no');

  it('§6-7 两个子问题（cyclic + unidirectional）⇒ sub_modules 长度 2 且类型各自正确', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        description: '根',
        sub_problems: [cyclicChild, unidirectionalChild],
      }),
    );
    expect(result.causal_type).toBe('nested');
    expect(result.confidence).toBe(0.9);
    const subModules = result.sub_modules ?? [];
    expect(subModules.length).toBe(2);
    expect(subModules[0]?.name).toBe('sub-1');
    expect(subModules[1]?.name).toBe('sub-2');
    expect(subModules[0]?.classification.causal_type).toBe('cyclic');
    expect(subModules[0]?.classification.confidence).toBe(0.9);
    expect(subModules[1]?.classification.causal_type).toBe('unidirectional');
    expect(subModules[1]?.classification.confidence).toBe(0.9);
    for (const module of subModules) {
      expect(module.classification.evidence.length).toBeGreaterThan(0);
      for (const item of module.classification.evidence) {
        expect(item.statement.length).toBeGreaterThan(0);
      }
    }
    expectInvariants(result, 'nested/2children');
  });

  it('子问题 label 存在时 name 用 label（§4.3 name = sub.label ?? sub-N）', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [
          makeProblem('no', 'yes', 'no', 'no', { label: '甲' }),
          makeProblem('no', 'no', 'no', 'yes', { label: '乙' }),
        ],
      }),
    );
    const subModules = result.sub_modules ?? [];
    expect(subModules.map((module) => module.name)).toStrictEqual(['甲', '乙']);
    expect(subModules[1]?.classification.causal_type).toBe('nested');
  });

  it('§4.3 拆分时追加一条 SUBMODULE 证据，statement 含子模块数量与名字', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [
          makeProblem('no', 'yes', 'no', 'no', { label: '甲' }),
          makeProblem('no', 'no', 'yes', 'no', { label: '乙' }),
        ],
      }),
    );
    const submoduleEvidence = result.evidence.filter((item) => item.source === 'SUBMODULE');
    expect(submoduleEvidence.length).toBe(1);
    const statement = submoduleEvidence[0]?.statement ?? '';
    expect(statement).toContain('2');
    expect(statement).toContain('甲');
    expect(statement).toContain('乙');
    // 主判据仍在末尾
    const last = mainRuleEvidence(result);
    expect(last.source).toBe('RULE');
  });

  it('nested 但无 sub_problems ⇒ sub_modules = []（字段必须存在）', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('no', 'no', 'no', 'yes'));
    expect(result.causal_type).toBe('nested');
    expect(Array.isArray(result.sub_modules)).toBe(true);
    expect(result.sub_modules).toStrictEqual([]);
  });

  it('§6-8 max_depth = 0 且根为 nested ⇒ sub_modules = []（不校验也不下探）', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', { sub_problems: [cyclicChild] }),
      { max_depth: 0 },
    );
    expect(result.causal_type).toBe('nested');
    expect(result.sub_modules).toStrictEqual([]);
    expectInvariants(result, 'max_depth=0');
  });

  it('max_depth = 1 ⇒ 根（depth 0）下探一层，嵌套子问题自身不再下探', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [cyclicChild, makeProblem('no', 'no', 'no', 'yes', { sub_problems: [cyclicChild] })],
      }),
      { max_depth: 1 },
    );
    const subModules = result.sub_modules ?? [];
    expect(subModules.length).toBe(2);
    expect(subModules[1]?.classification.causal_type).toBe('nested');
    expect(subModules[1]?.classification.sub_modules).toStrictEqual([]);
  });

  it('max_depth = 2 ⇒ 嵌套子问题（depth 1）仍可下探一层', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', {
        sub_problems: [
          cyclicChild,
          makeProblem('no', 'no', 'no', 'yes', { sub_problems: [unidirectionalChild] }),
        ],
      }),
      { max_depth: 2 },
    );
    const nestedChild = (result.sub_modules ?? [])[1]?.classification;
    expect(nestedChild?.causal_type).toBe('nested');
    const grandChildren = nestedChild?.sub_modules ?? [];
    expect(grandChildren.length).toBe(1);
    expect(grandChildren[0]?.name).toBe('sub-1');
    expect(grandChildren[0]?.classification.causal_type).toBe('unidirectional');
  });

  it('max_depth 缺省等于 DEFAULT_MAX_DEPTH(3)：显式传 3 结果深度相等', () => {
    const input = makeProblem('no', 'no', 'no', 'yes', {
      sub_problems: [
        cyclicChild,
        makeProblem('no', 'no', 'no', 'yes', { sub_problems: [unidirectionalChild] }),
      ],
    });
    expect(classifierPlugin.classifyProblem(input)).toStrictEqual(
      classifierPlugin.classifyProblem(input, { max_depth: 3 }),
    );
    // depth：根 0 → 子 1 → 孙 2，均在默认上限内
    const defaulted = classifierPlugin.classifyProblem(input);
    expect((defaulted.sub_modules ?? []).length).toBe(2);
    expect(((defaulted.sub_modules ?? [])[1]?.classification.sub_modules ?? []).length).toBe(1);
  });

  it('max_depth 取合法边界 8（MAX_DEPTH_LIMIT）不报错', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', { sub_problems: [cyclicChild] }),
      { max_depth: 8 },
    );
    expect(result.causal_type).toBe('nested');
    expect((result.sub_modules ?? []).length).toBe(1);
  });

  it('三层链：根 → 嵌套子 → 结构二元孙，默认深度下全部展开', () => {
    const grandChild = makeProblem('yes', 'no', 'no', 'no');
    const nestedChild = makeProblem('no', 'no', 'no', 'yes', { sub_problems: [grandChild] });
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'yes', { sub_problems: [nestedChild] }),
    );
    const child = (result.sub_modules ?? [])[0]?.classification;
    expect(child?.causal_type).toBe('nested');
    const grand = (child?.sub_modules ?? [])[0]?.classification;
    expect(grand?.causal_type).toBe('structural_duality');
    expect(grand?.confidence).toBe(0.9);
    expect(grand?.sub_modules).toBeUndefined();
  });

  it('非 nested 结论 ⇒ sub_modules 必须不存在（undefined）', () => {
    for (const combo of allCombos()) {
      const outcome = expectedOutcome(combo.q1, combo.q2, combo.q3, combo.q4);
      if (outcome.causal_type === 'nested') continue;
      const result = classifierPlugin.classifyProblem(
        makeProblem(combo.q1, combo.q2, combo.q3, combo.q4, { sub_problems: [cyclicChild] }),
      );
      expect(result.sub_modules).toBeUndefined();
    }
  });

  it('R4 结论同样不下探（candidate_hypotheses 存在、sub_modules 不存在）', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('no', 'no', 'no', 'no', { sub_problems: [cyclicChild] }),
    );
    expect(result.causal_type).toBe('unknown');
    expect(result.sub_modules).toBeUndefined();
    expect(result.candidate_hypotheses).toBeDefined();
    expect(ruleTrace(result, 'R4').fired).toBe(true);
  });

  it('契约字段名一致性：answer4 生成的键即 FOUR_QUESTIONS 的 answer_key', () => {
    const answers = answer4('yes', 'no', 'unknown', 'no');
    expect(Object.keys(answers).sort()).toStrictEqual(
      [
        'q1_simultaneous_mutual_definition',
        'q2_delayed_mutual_influence',
        'q3_strict_irreversible_order',
        'q4_coexisting_causal_structures',
      ].sort(),
    );
  });
});