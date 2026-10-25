/**
 * SPEC §4 判据规则表与 §4.1 数值表 —— 逐条数值断言（对应 §6 验证方第 2、3、4、5 项）。
 *
 * 所有期望值来自 `docs/SPEC-classifier.md`；类型名与四问映射来自契约
 * `FOUR_QUESTIONS` / `KNOWN_CAUSAL_TYPES` 的冻结定义，不从实现反推。
 */
import { describe, expect, it } from 'vitest';

import { KNOWN_CAUSAL_TYPES } from '@clis/clis-contracts';
import * as classifierPlugin from '@clis/clis-classifier';

import {
  expectedOutcome,
  expectInvariants,
  expectMainRuleEvidence,
  makeProblem,
  ruleTrace,
} from './helpers';

describe('SPEC §4.1 R2 —— 唯一 yes 决定类型，置信度 = 0.9 - 0.08 × unknown 数', () => {
  const uniqueYesCases = [
    { name: 'Q1=yes ⇒ structural_duality', q1: 'yes', q2: 'no', q3: 'no', type: 'structural_duality' },
    { name: 'Q2=yes ⇒ cyclic', q1: 'no', q2: 'yes', q3: 'no', type: 'cyclic' },
    { name: 'Q3=yes ⇒ unidirectional', q1: 'no', q2: 'no', q3: 'yes', type: 'unidirectional' },
  ] as const;

  for (const testCase of uniqueYesCases) {
    it(`${testCase.name}，confidence = 0.9，needs_exploration = false`, () => {
      const result = classifierPlugin.classifyProblem(
        makeProblem(testCase.q1, testCase.q2, testCase.q3, 'no'),
      );

      expect(result.causal_type).toBe(testCase.type);
      expect(result.confidence).toBe(0.9);
      expect(result.needs_exploration).toBe(false);
      expect(result.exploration_reason).toBeUndefined();
      expect(result.candidate_hypotheses).toBeUndefined();
      expect(result.sub_modules).toBeUndefined();

      expect(ruleTrace(result, 'R2').fired).toBe(true);
      expect(ruleTrace(result, 'R1').fired).toBe(false);
      expect(ruleTrace(result, 'R3').fired).toBe(false);
      expect(ruleTrace(result, 'R4').fired).toBe(false);
      expectMainRuleEvidence(result, 'R2');
      expectInvariants(result, testCase.name);
    });
  }

  it('R5 扣分阶梯：1 个 unknown ⇒ 0.82 且不探索', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'no', 'no', 'unknown'));
    expect(result.causal_type).toBe('structural_duality');
    expect(result.confidence).toBe(0.82);
    expect(result.needs_exploration).toBe(false);
    expect(result.exploration_reason).toBeUndefined();
    expectInvariants(result, 'R2/1unknown');
  });

  it('§6-2 边界：2 个 unknown ⇒ confidence = 0.74 ⇒ needs_exploration = false', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'unknown', 'no', 'unknown'));
    expect(result.causal_type).toBe('structural_duality');
    expect(result.confidence).toBe(0.74);
    expect(result.needs_exploration).toBe(false);
    expect(result.exploration_reason).toBeUndefined();
    // 同一条 R7 的严格小于：0.74 不低于阈值 0.7
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expectInvariants(result, 'R2/2unknown');
  });

  it('§6-2 边界：3 个 unknown ⇒ confidence = 0.66 ⇒ needs_exploration = true 且 reason 非空', () => {
    const result = classifierPlugin.classifyProblem(
      makeProblem('yes', 'unknown', 'unknown', 'unknown'),
    );
    expect(result.causal_type).toBe('structural_duality');
    expect(result.confidence).toBe(0.66);
    expect(result.needs_exploration).toBe(true);
    expect(typeof result.exploration_reason).toBe('string');
    expect((result.exploration_reason ?? '').length).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.7);
    expectInvariants(result, 'R2/3unknown');
  });
});

describe('SPEC §4.1 R1 —— Q4=yes ⇒ nested，置信度 = 0.9 - 0.08 × unknown 数', () => {
  it('Q4=yes、Q1..Q3 全 no ⇒ nested / 0.9 / 不探索', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('no', 'no', 'no', 'yes'));
    expect(result.causal_type).toBe('nested');
    expect(result.confidence).toBe(0.9);
    expect(result.needs_exploration).toBe(false);
    expect(result.exploration_reason).toBeUndefined();
    expect(ruleTrace(result, 'R1').fired).toBe(true);
    expect(ruleTrace(result, 'R3').fired).toBe(false);
    expectMainRuleEvidence(result, 'R1');
    expectInvariants(result, 'R1/all-no');
  });

  it('Q4=yes 且 1 个 unknown ⇒ nested / 0.82 / 不探索', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('unknown', 'no', 'no', 'yes'));
    expect(result.causal_type).toBe('nested');
    expect(result.confidence).toBe(0.82);
    expect(result.needs_exploration).toBe(false);
    expectInvariants(result, 'R1/1unknown');
  });

  it('对抗性：Q4=yes 且 Q1/Q2/Q3 全 yes ⇒ 仍为 R1，R3 不得触发，confidence = 0.9', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'yes', 'yes', 'yes'));
    expect(result.causal_type).toBe('nested');
    expect(result.confidence).toBe(0.9);
    expect(result.needs_exploration).toBe(false);
    expect(ruleTrace(result, 'R1').fired).toBe(true);
    expect(ruleTrace(result, 'R3').fired).toBe(false);
    // R1 未触发 R3，因此不得出现冲突证据：只剩末尾主判据一条 RULE 证据
    expect(result.evidence.filter((item) => item.source === 'RULE').length).toBe(1);
    expectMainRuleEvidence(result, 'R1');
    expectInvariants(result, 'R1/d>=2');
  });
});

describe('SPEC §4.1 R3 —— 结构冲突 ⇒ nested，置信度再扣 0.15', () => {
  it('§6-3 R3 冲突路径：Q1=yes, Q2=yes, Q4=no ⇒ nested 且 confidence = 0.75', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'yes', 'no', 'no'));
    expect(result.causal_type).toBe('nested');
    expect(result.confidence).toBe(0.75);
    expect(result.needs_exploration).toBe(false);
    expect(result.exploration_reason).toBeUndefined();
    expect(ruleTrace(result, 'R3').fired).toBe(true);
    expect(ruleTrace(result, 'R2').fired).toBe(false);
    expectMainRuleEvidence(result, 'R3');
    expectInvariants(result, 'R3/base');
  });

  it('R3 且 d = 3 ⇒ 同样 nested / 0.75（R6 只扣一次）', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'yes', 'yes', 'no'));
    expect(result.causal_type).toBe('nested');
    expect(result.confidence).toBe(0.75);
    expect(result.needs_exploration).toBe(false);
    expectInvariants(result, 'R3/d=3');
  });

  it('R3 且 1 个 unknown ⇒ 0.9 - 0.08 - 0.15 = 0.67 ⇒ needs_exploration = true', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'yes', 'unknown', 'no'));
    expect(result.causal_type).toBe('nested');
    expect(result.confidence).toBe(0.67);
    expect(result.needs_exploration).toBe(true);
    expect((result.exploration_reason ?? '').length).toBeGreaterThan(0);
    expectInvariants(result, 'R3/1unknown');
  });

  it('SPEC §5：R3 触发时额外给出一条 RULE 来源的冲突证据', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'yes', 'no', 'no'));
    const ruleEvidence = result.evidence.filter((item) => item.source === 'RULE');
    expect(ruleEvidence.length).toBe(2);
    const conflict = ruleEvidence[0];
    const mainJudgment = ruleEvidence[1];
    expect(conflict).toBeDefined();
    expect(mainJudgment).toBeDefined();
    expect((conflict as { statement: string }).statement.length).toBeGreaterThan(0);
    expect((conflict as { statement: string }).statement).not.toBe(
      (mainJudgment as { statement: string }).statement,
    );
    expectMainRuleEvidence(result, 'R3');
  });
});

describe('SPEC §4.1 R4 —— 不强行归类：unknown 结论与候选假设', () => {
  it('四问全 no ⇒ unknown / 0.4 / 探索，候选四类各 0.3 且保持 KNOWN 顺序', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('no', 'no', 'no', 'no'));
    expect(result.causal_type).toBe('unknown');
    expect(result.confidence).toBe(0.4);
    expect(result.needs_exploration).toBe(true);
    expect((result.exploration_reason ?? '').length).toBeGreaterThan(0);
    expect(result.sub_modules).toBeUndefined();

    expect(ruleTrace(result, 'R4').fired).toBe(true);
    expect(ruleTrace(result, 'R1').fired).toBe(false);
    expect(ruleTrace(result, 'R2').fired).toBe(false);
    expect(ruleTrace(result, 'R3').fired).toBe(false);
    expectMainRuleEvidence(result, 'R4');

    const candidates = result.candidate_hypotheses ?? [];
    expect(candidates.map((candidate) => candidate.causal_type)).toStrictEqual([
      ...KNOWN_CAUSAL_TYPES,
    ]);
    expect(candidates.map((candidate) => candidate.confidence)).toStrictEqual([0.3, 0.3, 0.3, 0.3]);
    for (const candidate of candidates) {
      expect(candidate.rationale.length).toBeGreaterThan(0);
    }
    expectInvariants(result, 'R4/all-no');
  });

  it('含 unknown ⇒ unknown / 0.25 / 探索，候选四类各 0.2 且保持 KNOWN 顺序', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('unknown', 'no', 'no', 'no'));
    expect(result.causal_type).toBe('unknown');
    expect(result.confidence).toBe(0.25);
    expect(result.needs_exploration).toBe(true);
    expect((result.exploration_reason ?? '').length).toBeGreaterThan(0);

    const candidates = result.candidate_hypotheses ?? [];
    expect(candidates.map((candidate) => candidate.causal_type)).toStrictEqual([
      ...KNOWN_CAUSAL_TYPES,
    ]);
    expect(candidates.map((candidate) => candidate.confidence)).toStrictEqual([0.2, 0.2, 0.2, 0.2]);
    expectInvariants(result, 'R4/1unknown');
  });

  it('Q4=unknown 且 Q1..Q3 全 no ⇒ 走 R4（d=0），confidence = 0.25', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('no', 'no', 'no', 'unknown'));
    expect(result.causal_type).toBe('unknown');
    expect(result.confidence).toBe(0.25);
    expect(result.needs_exploration).toBe(true);
    expect(ruleTrace(result, 'R4').fired).toBe(true);
    expect(ruleTrace(result, 'R1').fired).toBe(false);
    expectInvariants(result, 'R4/q4-unknown');
  });

  it('非 unknown 结论 ⇒ candidate_hypotheses 必须不存在', () => {
    for (const combo of [
      ['yes', 'no', 'no', 'no'],
      ['no', 'yes', 'no', 'no'],
      ['no', 'no', 'yes', 'no'],
      ['yes', 'yes', 'no', 'no'],
      ['no', 'no', 'no', 'yes'],
    ] as const) {
      const result = classifierPlugin.classifyProblem(
        makeProblem(combo[0], combo[1], combo[2], combo[3]),
      );
      expect(result.causal_type).not.toBe('unknown');
      expect(result.candidate_hypotheses).toBeUndefined();
    }
  });
});

describe('SPEC §4 判据轨迹 —— R1–R11 每条各一项', () => {
  it('judgment_basis 恰好包含 R1..R11 各一项，触发的规则都有非空 effect', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'yes', 'no', 'no'));
    const ids = result.judgment_basis.map((basis) => basis.rule_id);
    expect(ids.length).toBe(11);
    expect(new Set(ids).size).toBe(11);
    for (const ruleId of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11']) {
      expect(ids).toContain(ruleId);
    }
    const fired = result.judgment_basis.filter((basis) => basis.fired);
    expect(fired.length).toBeGreaterThan(0);
    for (const basis of fired) {
      expect(typeof basis.effect).toBe('string');
      expect((basis.effect ?? '').length).toBeGreaterThan(0);
    }
  });

  it('预期预言机与实现一致（R3 路径的 fired 集合）', () => {
    const result = classifierPlugin.classifyProblem(makeProblem('yes', 'yes', 'no', 'no'));
    const outcome = expectedOutcome('yes', 'yes', 'no', 'no');
    expect(result.confidence).toBe(outcome.confidence);
    expect(result.causal_type).toBe(outcome.causal_type);
    expect(ruleTrace(result, 'R3').fired).toBe(outcome.r3);
    expect(ruleTrace(result, 'R4').fired).toBe(outcome.r4);
  });
});